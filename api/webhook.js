import fetch from 'node-fetch';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/* ========= Config (env-driven) ========= */
const OPENAI_URL   = 'https://api.openai.com/v1/chat/completions';
const MODEL        = process.env.MODEL_DEFAULT || 'gpt-4.1';
const TEMPERATURE  = Number(process.env.TEMP_DEFAULT ?? 0.30);
const MAX_TURNS    = 18; // memory depth
const INVENTORY_ENDPOINT = process.env.INVENTORY_ENDPOINT; // Apps Script /exec URL

// Phase 1 stop line (exact match)
const STOP_LINE = 'GOT IT! ✅ I now have everything I need. I can now search available units for you.';

// Load the qualifier system prompt from file
const QUALIFIER_PROMPT = await readFile(
  path.join(process.cwd(), 'prompts', 'qualifier.txt'),
  'utf8'
);

/* ========= In-memory session store (OK for now) ========= */
// chat history for LLM
const sessions = new Map();
// ui state for selection/scheduling
const uiState = new Map(); // { stage, lastMatches, selectedIndex, selectedUnit, schedule: {when, phone} }

function historyFor(senderId) {
  if (!sessions.has(senderId)) {
    sessions.set(senderId, [
      { role: 'system', content: QUALIFIER_PROMPT }
    ]);
  }
  return sessions.get(senderId);
}
function clampHistory(arr) {
  const systemMsg = arr[0];
  const tail = arr.slice(-MAX_TURNS * 2);
  return [systemMsg, ...tail];
}
function stateFor(psid) {
  if (!uiState.has(psid)) uiState.set(psid, { stage: 'idle' });
  return uiState.get(psid);
}

/* ========= OpenAI + Messenger helpers ========= */
async function sendToOpenAI(history) {
  const resp = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      messages: history,
      temperature: TEMPERATURE
    })
  });
  const json = await resp.json();
  if (!resp.ok) {
    console.error('OpenAI error:', resp.status, json);
    throw new Error('OpenAI request failed');
  }
  return json?.choices?.[0]?.message?.content?.trim() || '';
}

async function sendToMessenger(psid, text) {
  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${process.env.FB_PAGE_TOKEN}`;
  const body = {
    messaging_type: 'RESPONSE',
    recipient: { id: psid },
    message: { text }
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const msg = await r.text();
    console.error('Messenger Send API error:', r.status, msg);
  }
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
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const msg = await r.text();
    console.error('Messenger Quick Replies error:', r.status, msg);
  }
}

async function sendImage(psid, imageUrl) {
  if (!imageUrl) return;
  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${process.env.FB_PAGE_TOKEN}`;
  const body = {
    recipient: { id: psid },
    message: {
      attachment: {
        type: 'image',
        payload: { url: imageUrl, is_reusable: false }
      }
    }
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const msg = await r.text();
    console.error('Messenger Image error:', r.status, msg);
  }
}

/* ========= Phase-2: Inventory matching (Apps Script JSON) ========= */
async function fetchInventoryFromAppsScript() {
  if (!INVENTORY_ENDPOINT) throw new Error('INVENTORY_ENDPOINT not set');
  const r = await fetch(INVENTORY_ENDPOINT, { method: 'GET' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Inventory fetch failed: ${r.status}`);
  return Array.isArray(j.items) ? j.items : [];
}

/* ===== Utilities for wants, relax, scoring ===== */
const MODEL_TOKENS = [
  'suv','sedan','mpv','hatchback','pickup','van','vios','fortuner','innova','terra',
  'xpander','stargazer','l300','hiace','grandia','commuter','urvan','nv350','avanza','altis',
  'wigo','brv','br-v','brio','civic','city','accent','elantra','everest','ranger'
];

function extractWants(history) {
  const text = history.map(m => m.content).join(' ').toLowerCase();

  const want = {
    payment: /financ/i.test(text) ? 'financing' : (/cash/i.test(text) ? 'cash' : null),
    cash_budget_min: null, cash_budget_max: null,
    dp_min: null, dp_max: null,
    city: null, province: null,
    preferred_type_or_model: null
  };

  // cash budget range like "400k-500k"
  const range = text.match(/(\d[\d,\.]*)\s*[-–]\s*(\d[\d,\.]*)/);
  if (range && want.payment === 'cash') {
    const a = Number(range[1].replace(/[^\d]/g,'')); 
    const b = Number(range[2].replace(/[^\d]/g,''));
    want.cash_budget_min = Math.min(a,b); 
    want.cash_budget_max = Math.max(a,b);
  } else if (want.payment === 'cash') {
    const single = text.match(/(?:budget|cash)\D{0,8}(\d[\d,\.]*)/);
    if (single) {
      const v = Number(single[1].replace(/[^\d]/g,''));
      if (isFinite(v)) { want.cash_budget_min = v*0.9; want.cash_budget_max = v*1.1; }
    }
  }

  // financing DP like "80k dp"
  const dp = text.match(/(?:dp|down ?payment)[^\d]{0,8}(\d[\d,\.]*)/);
  if (dp && want.payment === 'financing') {
    const v = Number(dp[1].replace(/[^\d]/g,''));
    if (isFinite(v)) { want.dp_min = v*0.9; want.dp_max = v*1.1; }
  }

  // basic city/province detection (expand later)
  const cityHit = text.match(/\b(quezon city|qc|manila|makati|pasig|pasay|taguig|mandaluyong|marikina|caloocan|antipolo|cebu|davao|cavite)\b/);
  if (cityHit) want.city = cityHit[0];

  // body type or model keywords
  const typeHit = MODEL_TOKENS.find(t => text.includes(t));
  if (typeHit) want.preferred_type_or_model = typeHit;

  return want;
}

function relaxWants(w) {
  const clone = { ...w };
  // widen budgets by ~25%
  if (clone.cash_budget_min != null) clone.cash_budget_min *= 0.85;
  if (clone.cash_budget_max != null) clone.cash_budget_max *= 1.25;
  if (clone.dp_min != null) clone.dp_min *= 0.85;
  if (clone.dp_max != null) clone.dp_max *= 1.25;
  // relax city (keep province/model)
  clone.city = null;
  return clone;
}

function isAffirmation(text) {
  return /^(yes|yep|sure|sige|ok|okay|game|go ahead|go|opo|oo|ayos|tara)\b/i.test(text.trim());
}

function rankMatches(rows, want) {
  const n = s => (s ?? '').toString().trim().toLowerCase();
  const num = v => {
    const x = Number(String(v).replace(/[₱,]/g,'').trim());
    return isFinite(x) ? x : null;
  };

  return rows.map(r => {
    const city = n(r.city);
    const prov = n(r.province);
    const body = n(r.body_type);
    const brand = n(r.brand);
    const model = n(r.model);
    const variant = n(r.variant);
    const price = num(r.srp ?? r.price);
    const dp = num(r.dp); // optional

    let score = 0;

    // Budget fit
    if (want.payment === 'cash' && price != null) {
      if (want.cash_budget_min != null && want.cash_budget_max != null) {
        if (price >= want.cash_budget_min && price <= want.cash_budget_max) score += 60;
        else if (price >= want.cash_budget_min*0.9 && price <= want.cash_budget_max*1.1) score += 40;
      }
    }
    if (want.payment === 'financing' && dp != null) {
      if (want.dp_min != null && want.dp_max != null) {
        if (dp >= want.dp_min && dp <= want.dp_max) score += 60;
        else if (dp >= want.dp_min*0.9 && dp <= want.dp_max*1.1) score += 40;
      }
    }

    // Location
    if (want.city && city && city === n(want.city)) score += 20;
    else if (want.province && prov && prov === n(want.province)) score += 12;

    // Preference (type/model)
    const blob = [brand, model, variant, body].join(' ');
    if (want.preferred_type_or_model && blob.includes(n(want.preferred_type_or_model))) score += 15;
    else if (want.preferred_type_or_model && body.includes(n(want.preferred_type_or_model))) score += 10;

    // Newer year tiny bump
    const yr = Number(r.year) || 0;
    score += Math.min(Math.max(yr - 2000, 0), 5) * 0.5;

    return { score, row: r };
  })
  .sort((a,b) => b.score - a.score)
  .map(x => x.row);
}

function formatMatches(rows, limit = 3) {
  const pick = rows.slice(0, limit);
  if (!pick.length) return '';
  return pick.map((r, i) => {
    const brand = r.brand || '';
    const model = r.model || '';
    const variant = r.variant || '';
    const year = r.year || '';
    const price = r.srp ?? r.price ?? '';
    const city = r.city || '';
    const mileage = r.mileage ? `${r.mileage} km` : '';
    return `${i+1}. ${brand} ${model} ${variant} ${year} — ₱${price} — ${city}${mileage ? ' — ' + mileage : ''}`;
  }).join('\n');
}

/* Run matching once; if no results and relax=true, it retries with relaxed wants */
async function runMatching(psid, history, { relax = false } = {}) {
  const all = await fetchInventoryFromAppsScript();
  const wants = relax ? relaxWants(extractWants(history)) : extractWants(history);
  const ranked = rankMatches(all, wants);
  return ranked;
}

/* ========= Webhook handler ========= */
export default async function handler(req, res) {
  // Verification (GET)
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.FB_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  // Messages (POST)
  if (req.method === 'POST') {
    try {
      const body = req.body;
      if (body.object !== 'page') return res.status(404).send('Not a page subscription');

      for (const entry of body.entry || []) {
        for (const event of entry.messaging || []) {
          const psid = event?.sender?.id;
          if (!psid) continue;

          const userText =
            event?.message?.text ||
            event?.postback?.title ||
            '';
          if (!userText) continue;

          const state = stateFor(psid);

          /* ===== Phase 3: handle selection/scheduling states first ===== */
          if (state.stage === 'awaiting_selection') {
            const pickedNum = parseInt(userText.trim(), 10);
            if (Number.isFinite(pickedNum) && pickedNum >= 1 && pickedNum <= (state.lastMatches?.length || 0)) {
              state.selectedIndex = pickedNum - 1;
              state.selectedUnit = state.lastMatches[state.selectedIndex];
              // show one photo + short card + schedule CTA
              const u = state.selectedUnit;
              if (u?.image_1) await sendImage(psid, u.image_1);
              const card = `${u.brand || ''} ${u.model || ''} ${u.variant || ''} ${u.year || ''}\n` +
                           `₱${u.srp ?? ''} — ${u.city || ''}${u.mileage ? ' — ' + u.mileage + ' km' : ''}`;
              await sendQuickReplies(psid,
                `Nice choice! ✅\n${card}\n\nGusto mo bang i-schedule ang viewing?`,
                ['Schedule viewing', 'Show other units']
              );
              state.stage = 'after_choice';
              uiState.set(psid, state);
              continue;
            }
            if (/see more|more|iba pa/i.test(userText)) {
              // (future) pagination
              await sendToMessenger(psid, 'Sige, dadagdagan pa natin soon ang list. For now, pili ka muna sa 1–3.');
              continue;
            }
          } else if (state.stage === 'after_choice') {
            if (/schedule/i.test(userText)) {
              await sendToMessenger(psid, 'Great! Anong preferred **date & time** mo? (e.g., "Fri 3pm" or "Nov 8, 2pm")');
              state.stage = 'awaiting_when';
              uiState.set(psid, state);
              continue;
            }
            if (/show other|iba/i.test(userText)) {
              await sendToMessenger(psid, 'Noted. Pili ka ulit mula sa list, or sabihin mo kung anong model ang gusto mo.');
              state.stage = 'awaiting_selection';
              uiState.set(psid, state);
              continue;
            }
          } else if (state.stage === 'awaiting_when') {
            state.schedule = state.schedule || {};
            state.schedule.when = userText.trim();
            await sendToMessenger(psid, 'Got it. Pakibigay din po ang **mobile number** para ma-confirm ng branch (e.g., 0917xxxxxxx).');
            state.stage = 'awaiting_phone';
            uiState.set(psid, state);
            continue;
          } else if (state.stage === 'awaiting_phone') {
            state.schedule.phone = userText.trim();
            const u = state.selectedUnit || {};
            const summary =
              `✅ Tentative viewing set!\n` +
              `Unit: ${u.brand || ''} ${u.model || ''} ${u.variant || ''} ${u.year || ''}\n` +
              `Price: ₱${u.srp ?? ''}\n` +
              `When: ${state.schedule.when}\n` +
              `Buyer mobile: ${state.schedule.phone}\n` +
              `Location: ${u.complete_address || u.city || 'branch to confirm'}`;
            await sendToMessenger(psid, summary);
            await sendToMessenger(psid, 'Our team will confirm the exact branch schedule. Anything else you’d like to check?');

            // TODO: push to your ops channel (Telegram/Sheets/Email)
            state.stage = 'idle';
            uiState.set(psid, state);
            continue;
          }

          /* ===== If user says "yes/sure" after no-match, do relaxed matching immediately ===== */
          if (isAffirmation(userText) && state.stage === 'idle' && state.lastAskedNoMatch) {
            try {
              const hist = historyFor(psid);
              const ranked = await runMatching(psid, hist, { relax: true });
              if (ranked.length) {
                const list = formatMatches(ranked, 3);
                await sendToMessenger(psid, 'Nag-loosen ako ng criteria para may maipakita:');
                await sendToMessenger(psid, list);
                await sendQuickReplies(psid, 'Anong number ang pipiliin mo?', ['1', '2', '3', 'See more']);
                state.lastMatches = ranked.slice(0, 3);
                state.stage = 'awaiting_selection';
                state.lastAskedNoMatch = false;
                uiState.set(psid, state);
              } else {
                await sendToMessenger(psid, 'Wala pa rin akong makita na pasok. Pwede tayong maghanap ng ibang model or ibang budget.');
              }
            } catch (e) {
              console.error('Relaxed matching error:', e);
            }
            // continue to LLM acknowledge
          }

          /* ===== Phase 1: LLM conversation ===== */
          const hist = historyFor(psid);
          hist.push({ role: 'user', content: userText });

          const reply = await sendToOpenAI(hist);
          if (reply) {
            hist.push({ role: 'assistant', content: reply });
            sessions.set(psid, clampHistory(hist));
            await sendToMessenger(psid, reply);
          }

          /* ===== Phase 2: once qualifier finishes, run matching ===== */
          if (reply && reply.includes(STOP_LINE)) {
            try {
              const ranked = await runMatching(psid, hist, { relax: false });
              if (ranked.length) {
                const list = formatMatches(ranked, 3);
                await sendToMessenger(psid, 'Ito yung best na swak sa budget/location mo para di ka na mag-scroll:');
                await sendToMessenger(psid, list);
                await sendQuickReplies(psid, 'Anong number ang pipiliin mo?', ['1', '2', '3', 'See more']);
                const st = stateFor(psid);
                st.lastMatches = ranked.slice(0, 3);
                st.stage = 'awaiting_selection';
                st.lastAskedNoMatch = false;
                uiState.set(psid, st);
              } else {
                await sendToMessenger(psid, 'Walang exact match. Okay ba i-expand ng konti ang budget or nearby cities para may maipakita ako?');
                const st = stateFor(psid);
                st.lastAskedNoMatch = true;
                uiState.set(psid, st);
              }
            } catch (e) {
              console.error('Matching error:', e);
              await sendToMessenger(psid, 'Nagkaproblema sa paghanap ng units. Subukan natin ulit mamaya or i-tweak natin criteria.');
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
