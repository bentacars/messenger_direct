import fetch from 'node-fetch';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/* ========= Config ========= */
const OPENAI_URL   = 'https://api.openai.com/v1/chat/completions';
const MODEL        = process.env.MODEL_DEFAULT || 'gpt-4.1';
const TEMPERATURE  = Number(process.env.TEMP_DEFAULT ?? 0.30);
const MAX_TURNS    = 18;
const INVENTORY_ENDPOINT = process.env.INVENTORY_ENDPOINT;

const STOP_LINE = 'GOT IT! ✅ I now have everything I need. I can now search available units for you.';

const QUALIFIER_PROMPT = await readFile(
  path.join(process.cwd(), 'prompts', 'qualifier.txt'),
  'utf8'
);

/* ========= Session stores ========= */
const sessions = new Map(); // LLM history
const uiState  = new Map(); // selection/scheduling

function historyFor(psid) {
  if (!sessions.has(psid)) {
    sessions.set(psid, [
      { role: 'system', content: QUALIFIER_PROMPT }
    ]);
  }
  return sessions.get(psid);
}
function clampHistory(arr) {
  const sys = arr[0];
  const tail = arr.slice(-MAX_TURNS * 2);
  return [sys, ...tail];
}
function stateFor(psid) {
  if (!uiState.has(psid)) uiState.set(psid, { stage: 'idle' });
  return uiState.get(psid);
}

/* ========= Helpers: OpenAI + Messenger ========= */
async function sendToOpenAI(history) {
  const resp = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: MODEL, messages: history, temperature: TEMPERATURE })
  });
  const json = await resp.json();
  if (!resp.ok) {
    console.error('OpenAI error:', resp.status, json);
    throw new Error('OpenAI request failed');
  }
  return json?.choices?.[0]?.message?.content?.trim() || '';
}

async function sendText(psid, text) {
  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${process.env.FB_PAGE_TOKEN}`;
  const body = { messaging_type: 'RESPONSE', recipient: { id: psid }, message: { text } };
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) console.error('Messenger sendText error:', r.status, await r.text());
}

async function sendQuickReplies(psid, text, replies) {
  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${process.env.FB_PAGE_TOKEN}`;
  const body = {
    messaging_type: 'RESPONSE',
    recipient: { id: psid },
    message: {
      text,
      quick_replies: replies.map(t => ({ content_type: 'text', title: t, payload: t }))
    }
  };
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) console.error('Messenger quick replies error:', r.status, await r.text());
}

async function sendImage(psid, imageUrl) {
  if (!imageUrl) return;
  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${process.env.FB_PAGE_TOKEN}`;
  const body = {
    recipient: { id: psid },
    message: { attachment: { type: 'image', payload: { url: imageUrl, is_reusable: false } } }
  };
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) console.error('Messenger image error:', r.status, await r.text());
}

/* ========= Inventory fetch ========= */
async function fetchInventory() {
  if (!INVENTORY_ENDPOINT) throw new Error('INVENTORY_ENDPOINT not set');
  const r = await fetch(INVENTORY_ENDPOINT);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Inventory fetch failed: ${r.status}`);
  if (Array.isArray(j.items)) return j.items;
  if (Array.isArray(j.data))  return j.data;
  if (Array.isArray(j))       return j;
  return [];
}

/* ========= Matching utilities ========= */
const STATIC_MODEL_TOKENS = [
  'suv','sedan','mpv','hatchback','pickup','van','vios','fortuner','innova','terra','xpander',
  'stargazer','l300','hiace','grandia','commuter','urvan','nv350','avanza','altis','wigo',
  'brv','br-v','brio','civic','city','accent','elantra','everest','ranger','traviz','carry','k2500'
];

function numLike(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^\d.]/g, ''));
  return isFinite(n) ? n : null;
}

function makeDynamicModelTokens(inventory) {
  const set = new Set(STATIC_MODEL_TOKENS);
  for (const r of inventory) {
    [r?.brand, r?.model, r?.variant, r?.brand_model]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .split(/[^a-z0-9\-]+/i)
      .forEach(tok => { if (tok && tok.length >= 3) set.add(tok); });
  }
  return Array.from(set);
}

function extractWants(history, inventory) {
  const text = history.map(m => m.content).join(' ').toLowerCase();

  const wants = {
    payment: /financ/i.test(text) ? 'financing' : (/cash/i.test(text) ? 'cash' : null),
    cash_budget_min: null, cash_budget_max: null,
    dp_min: null, dp_max: null,
    city: null, province: null,
    preferred_type_or_model: null
  };

  // cash range: "400k-500k"
  const range = text.match(/(\d[\d,\.]*)\s*[-–]\s*(\d[\d,\.]*)/);
  if (range && wants.payment === 'cash') {
    const a = numLike(range[1]), b = numLike(range[2]);
    if (a && b) { wants.cash_budget_min = Math.min(a,b); wants.cash_budget_max = Math.max(a,b); }
  } else if (wants.payment === 'cash') {
    const single = text.match(/(?:budget|cash)\D{0,8}(\d[\d,\.]*)/);
    if (single) {
      const v = numLike(single[1]); if (v) { wants.cash_budget_min = v*0.9; wants.cash_budget_max = v*1.1; }
    }
  }

  // financing DP: "dp 120k"
  const dp = text.match(/(?:dp|down ?payment)[^\d]{0,8}(\d[\d,\.]*)/);
  if (dp && wants.payment === 'financing') {
    const v = numLike(dp[1]); if (v) { wants.dp_min = v*0.9; wants.dp_max = v*1.1; }
  }

  // city detection (basic)
  const cityHit = text.match(/\b(quezon city|qc|manila|makati|pasig|pasay|taguig|mandaluyong|marikina|caloocan|antipolo|cebu|davao|cavite|parañaque|las piñas|muntinlupa)\b/);
  if (cityHit) wants.city = cityHit[0];

  // model/type detection (static + dynamic)
  const dynamicTokens = makeDynamicModelTokens(inventory);
  const hit = dynamicTokens.find(tok => text.includes(tok));
  if (hit) wants.preferred_type_or_model = hit;

  return wants;
}

function relaxWants(w) {
  const c = { ...w };
  if (c.cash_budget_min != null) c.cash_budget_min *= 0.85;
  if (c.cash_budget_max != null) c.cash_budget_max *= 1.25;
  if (c.dp_min != null)          c.dp_min          *= 0.85;
  if (c.dp_max != null)          c.dp_max          *= 1.25;
  c.city = null; // drop strict city
  return c;
}

function isAffirmation(text) {
  return /^(yes|yep|sure|sige|ok|okay|game|go ahead|go|opo|oo|ayos|tara)\b/i.test(text.trim());
}

function scoreRow(r, wants) {
  const n = s => (s ?? '').toString().trim().toLowerCase();
  const city  = n(r.city);
  const prov  = n(r.province);
  const body  = n(r.body_type);
  const brand = n(r.brand);
  const model = n(r.model);
  const variant = n(r.variant);

  // price fields
  const srp  = numLike(r.srp ?? r.price);
  const allIn = numLike(r.all_in); // assume "ready DP" proxy

  let score = 0;

  if (wants.payment === 'cash' && srp != null) {
    if (wants.cash_budget_min != null && wants.cash_budget_max != null) {
      if (srp >= wants.cash_budget_min && srp <= wants.cash_budget_max) score += 60;
      else if (srp >= wants.cash_budget_min*0.9 && srp <= wants.cash_budget_max*1.1) score += 40;
    }
  }

  if (wants.payment === 'financing' && allIn != null) {
    if (wants.dp_min != null && wants.dp_max != null) {
      if (allIn >= wants.dp_min && allIn <= wants.dp_max) score += 60;
      else if (allIn >= wants.dp_min*0.9 && allIn <= wants.dp_max*1.1) score += 40;
    }
  }

  if (wants.city && city && city === n(wants.city)) score += 20;
  else if (wants.province && prov && prov === n(wants.province)) score += 12;

  const blob = [brand, model, variant, body].join(' ');
  if (wants.preferred_type_or_model && blob.includes(n(wants.preferred_type_or_model))) score += 15;
  else if (wants.preferred_type_or_model && body.includes(n(wants.preferred_type_or_model))) score += 10;

  const yr = Number(r.year) || 0;
  score += Math.min(Math.max(yr - 2000, 0), 5) * 0.5;

  return score;
}

function rankMatches(rows, wants) {
  return rows.map(r => ({ score: scoreRow(r, wants), row: r }))
             .sort((a,b) => b.score - a.score)
             .map(x => x.row);
}

function shortCard(r, wants) {
  const brand = r.brand || '';
  const model = r.model || '';
  const variant = r.variant || '';
  const year = r.year || '';
  const city = r.city || '';
  const mileage = r.mileage ? `${r.mileage} km` : '';
  const priceLabel = (wants.payment === 'financing' ? 'All-in' : 'Price');
  const priceVal = wants.payment === 'financing' ? (r.all_in ?? r.srp ?? '') : (r.srp ?? r.price ?? '');
  return `${year} ${brand} ${model} ${variant}\n${priceLabel}: ₱${priceVal}\n${city}${mileage ? ' — ' + mileage : ''}`;
}

async function sendUnitCard(psid, row, wants) {
  const img = row.image_1 || row.image || row.image_link || null;
  if (img) await sendImage(psid, img);
  await sendText(psid, `🚗 ${shortCard(row, wants)}`);
}

/* ========= Matching runners ========= */
async function runMatching(history, { relax = false } = {}) {
  const rows = await fetchInventory();
  const wants = relax ? relaxWants(extractWants(history, rows))
                      : extractWants(history, rows);
  const ranked = rankMatches(rows, wants);
  return { ranked, wants };
}

/* ========= Webhook ========= */
export default async function handler(req, res) {
  // Verify
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.FB_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  if (req.method === 'POST') {
    try {
      const body = req.body;
      if (body.object !== 'page') return res.status(404).send('Not a page subscription');

      for (const entry of body.entry || []) {
        for (const event of entry.messaging || []) {
          const psid = event?.sender?.id;
          if (!psid) continue;

          const text = event?.message?.text || event?.postback?.title || '';
          if (!text) continue;

          const state = stateFor(psid);

          /* ===== Phase 3 state machine first ===== */
          if (state.stage === 'awaiting_selection') {
            const pickedNum = parseInt(text.trim(), 10);
            if (Number.isFinite(pickedNum) && pickedNum >= 1 && pickedNum <= (state.lastMatches?.length || 0)) {
              state.selectedIndex = pickedNum - 1;
              state.selectedUnit = state.lastMatches[state.selectedIndex];
              await sendUnitCard(psid, state.selectedUnit, state.wants || {});
              await sendQuickReplies(psid, 'Gusto mo bang i-schedule ang viewing?', ['Schedule viewing', 'Show other units']);
              state.stage = 'after_choice';
              uiState.set(psid, state);
              continue;
            }
            if (/see more|more|iba pa/i.test(text)) {
              await sendText(psid, 'Coming soon ang pagination. Pili muna sa 1–3, or sabihin mo kung anong model ang gusto mo.');
              continue;
            }
          } else if (state.stage === 'after_choice') {
            if (/schedule/i.test(text)) {
              await sendText(psid, 'Great! Anong preferred **date & time** mo? (e.g., "Fri 3pm" or "Nov 8, 2pm")');
              state.stage = 'awaiting_when';
              uiState.set(psid, state);
              continue;
            }
            if (/show other|iba/i.test(text)) {
              await sendText(psid, 'Noted. Pili ka ulit mula sa list, or sabihin mo kung anong model ang gusto mo.');
              state.stage = 'awaiting_selection';
              uiState.set(psid, state);
              continue;
            }
          } else if (state.stage === 'awaiting_when') {
            state.schedule = state.schedule || {};
            state.schedule.when = text.trim();
            await sendText(psid, 'Got it. Pakibigay po ang **mobile number** (e.g., 0917xxxxxxx).');
            state.stage = 'awaiting_phone';
            uiState.set(psid, state);
            continue;
          } else if (state.stage === 'awaiting_phone') {
            state.schedule.phone = text.trim();
            const u = state.selectedUnit || {};
            const summary =
`✅ Tentative viewing set!
Unit: ${u.year || ''} ${u.brand || ''} ${u.model || ''} ${u.variant || ''}
Price: ₱${u.srp ?? u.price ?? ''}
When: ${state.schedule.when}
Buyer mobile: ${state.schedule.phone}
Location: ${u.complete_address || u.city || 'branch to confirm'}`;
            await sendText(psid, summary);
            await sendText(psid, 'Our team will confirm the exact branch schedule. Anything else you’d like to check?');

            // TODO: push booking to Google Sheet / Telegram
            state.stage = 'idle';
            uiState.set(psid, state);
            continue;
          }

          /* ===== Handle "yes" after no-match to relax immediately ===== */
          if (isAffirmation(text) && state.stage === 'idle' && state.lastAskedNoMatch) {
            try {
              const hist = historyFor(psid);
              const { ranked, wants } = await runMatching(hist, { relax: true });
              if (ranked.length) {
                await sendText(psid, 'Nag-loosen ako ng criteria para may maipakita:');
                const top = ranked.slice(0, 3);
                for (const r of top) await sendUnitCard(psid, r, wants);
                await sendQuickReplies(psid, 'Anong number ang pipiliin mo?', ['1', '2', '3', 'See more']);
                state.lastMatches = top;
                state.wants = wants;
                state.stage = 'awaiting_selection';
                state.lastAskedNoMatch = false;
                uiState.set(psid, state);
              } else {
                await sendText(psid, 'Wala pa rin akong makita na pasok. Pwede tayong maghanap ng ibang model or ibang budget.');
              }
            } catch (e) { console.error('Relaxed matching error:', e); }
            // continue to LLM acknowledge
          }

          /* ===== Phase 1: LLM convo ===== */
          const hist = historyFor(psid);
          hist.push({ role: 'user', content: text });
          const reply = await sendToOpenAI(hist);
          if (reply) {
            hist.push({ role: 'assistant', content: reply });
            sessions.set(psid, clampHistory(hist));
            await sendText(psid, reply);
          }

          /* ===== Phase 2: on STOP_LINE, run strict match and send unit cards ===== */
          if (reply && reply.includes(STOP_LINE)) {
            try {
              const { ranked, wants } = await runMatching(hist, { relax: false });
              if (ranked.length) {
                await sendText(psid, 'Ito yung best na swak sa details mo para di ka na mag-scroll:');
                const top = ranked.slice(0, 3);
                for (const r of top) await sendUnitCard(psid, r, wants);
                await sendQuickReplies(psid, 'Anong number ang pipiliin mo?', ['1', '2', '3', 'See more']);
                const st = stateFor(psid);
                st.lastMatches = top;
                st.wants = wants;
                st.stage = 'awaiting_selection';
                st.lastAskedNoMatch = false;
                uiState.set(psid, st);
              } else {
                await sendText(psid, 'Walang exact match. Okay ba i-expand nang konti ang budget or nearby cities para may maipakita ako?');
                const st = stateFor(psid);
                st.lastAskedNoMatch = true;
                uiState.set(psid, st);
              }
            } catch (e) {
              console.error('Matching error:', e);
              await sendText(psid, 'Nagkaproblema sa paghanap ng units. Subukan natin ulit mamaya or i-tweak natin criteria.');
            }
          }
        }
      }

      return res.status(200).send('OK');
    } catch (err) {
      console.error('Webhook error:', err);
      return res.status(500).send('Server error');
    }
  }

  return res.status(405).send('Method Not Allowed');
}

export const config = { api: { bodyParser: true } };
