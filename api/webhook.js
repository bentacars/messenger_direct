// api/webhook.js
// Conversational Messenger webhook (no buttons) with human-style qualifying + 2-offer flow

import { sendText, sendTypingOn, sendTypingOff, sendImage } from './lib/messenger.js';

const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN;
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;
const INVENTORY_API_URL = process.env.INVENTORY_API_URL; // Apps Script endpoint
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL_DEFAULT = process.env.MODEL_DEFAULT || 'gpt-4.1';
const TEMP_DEFAULT = Number(process.env.TEMP_DEFAULT ?? 0.30);

// ---- simple in-memory sessions (ok for first release; move to Redis later) ----
const sessions = new Map();

function getState(senderId) {
  if (!sessions.has(senderId)) {
    sessions.set(senderId, {
      createdAt: Date.now(),
      phase: 'qualify',           // qualify → offer → await_selection → followup
      info: {},
      offered: [],
      lastOfferHash: '',
      greetDone: false,
      lastMsgTime: 0,
    });
  }
  return sessions.get(senderId);
}

function resetState(senderId) {
  sessions.delete(senderId);
  return getState(senderId);
}

// ---------- tiny NLP helpers ----------
const norm = s => (s || '').toString().trim().toLowerCase();
function hasWord(s, w) { return new RegExp(`\\b${w}\\b`, 'i').test(s || ''); }

function detectPayment(text) {
  const t = norm(text);
  if (/(cash\s?basis|full cash|spot\s?cash|cash\b)/i.test(t)) return 'cash';
  if (/financ(e|ing)|installment|hulugan|loan/i.test(t)) return 'financing';
  return null;
}
function detectBody(text) {
  const t = norm(text);
  if (/\bsedan\b/i.test(t)) return 'sedan';
  if (/\bsuv\b/i.test(t)) return 'suv';
  if (/\bmpv\b/i.test(t)) return 'mpv';
  if (/\bvan\b/i.test(t)) return 'van';
  if (/\bpick ?up\b/i.test(t)) return 'pickup';
  if (/\b(any|kahit ano)\b/i.test(t)) return 'any';
  return null;
}
function detectTransmission(text) {
  const t = norm(text);
  if (/\b(a\/?t|automatic|matic)\b/i.test(t)) return 'AT';
  if (/\b(m\/?t|manual)\b/i.test(t)) return 'MT';
  if (/\b(any)\b/i.test(t)) return 'any';
  return null;
}
function extractBudgetRange(text) {
  const t = norm(text).replace(/[,₱\s]/g, '');
  const m = t.match(/(\d{3,7})(?:-|\sto\s|~|–|—)(\d{3,7})/);
  if (m) {
    const a = Number(m[1]); const b = Number(m[2]);
    const min = Math.min(a,b); const max = Math.max(a,b);
    if (min && max) return { min, max };
  }
  const below = t.match(/(?:below|under|upto|up?to|max|hanggang)(\d{3,7})/);
  if (below) return { min: 0, max: Number(below[1]) };
  const single = t.match(/(\d{5,7})/);
  if (single) { const x = Number(single[1]); return { min: Math.max(0, x-50000), max: x+50000 }; }
  const withK = norm(text).match(/(\d{2,3})\s*k/);
  if (withK) { const x = Number(withK[1]) * 1000; return { min: Math.max(0, x-50000), max: x+50000 }; }
  return null;
}
function detectModel(text) {
  const t = norm(text);
  const list = ['vios','mirage','hiace','nv350','urvan','livina','terra','fortuner','innova','city','civic'];
  for (const m of list) if (hasWord(t, m)) return m;
  return null;
}
function isRestart(text) {
  const t = norm(text);
  return ['restart','ulit tayo','start over','bagong search','new inquiry'].some(k => hasWord(t,k));
}

// ---- Inventory fetch + selection ----
async function queryInventory(params) {
  const url = new URL(INVENTORY_API_URL);
  if (params.body) url.searchParams.set('body', params.body);
  if (params.trans) url.searchParams.set('trans', params.trans);
  if (params.city) url.searchParams.set('city', params.city);
  if (params.model) url.searchParams.set('model', params.model);
  if (params.mode) url.searchParams.set('mode', params.mode); // 'cash' | 'financing'
  if (params.cashMin != null) url.searchParams.set('cash_min', String(params.cashMin));
  if (params.cashMax != null) url.searchParams.set('cash_max', String(params.cashMax));
  if (params.allInMin != null) url.searchParams.set('allin_min', String(params.allInMin));
  if (params.allInMax != null) url.searchParams.set('allin_max', String(params.allInMax));
  url.searchParams.set('limit', '20');

  const res = await fetch(url.toString(), { method: 'GET', headers: { 'Accept': 'application/json' }});
  if (!res.ok) throw new Error(`Inventory HTTP ${res.status}`);
  return await res.json(); // expects {ok, count, items: [...]}
}
function prioritize(items) {
  const pri = items.filter(x => (x.price_status || '').toLowerCase() === 'priority');
  const rest = items.filter(x => (x.price_status || '').toLowerCase() !== 'priority');
  return [...pri, ...rest];
}
function pickTopTwo(items) { return prioritize(items).slice(0, 2); }

function shortCaption(item, index) {
  const n = index + 1;
  const yr = item.year ? `${item.year} ` : '';
  const name = [yr, item.brand, item.model, item.variant || ''].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
  const allin = item.all_in || item.price_all_in || item['all-in'] || item.allin;
  const km = item.mileage ? `${Number(item.mileage).toLocaleString()} km` : '';
  const city = item.city || (item.complete_address || '').split(',')[0];
  const priceLine = allin ? `All-in: ₱${Number(allin).toLocaleString()}` : (item.srp ? `Cash: ₱${Number(item.srp).toLocaleString()}` : '');
  const locLine = [city, km].filter(Boolean).join(' — ');
  return `#${n} ${name}\n${priceLine}\n${locLine}`;
}

// ---- LLM rewriter (optional; uses env model/temp directly) ----
async function llmRewrite(system, user) {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_DEFAULT,
        temperature: TEMP_DEFAULT,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
      })
    });
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || '').trim();
  } catch {
    return user; // fallback
  }
}

// ---- Qualifier flow ----
async function askNextQuestion(senderId, state) {
  const { info } = state;

  if (!state.greetDone) {
    state.greetDone = true;
    const msg = `Hi! You're talking to your personal BentaCars advisor. 👋
Before ko i-match, a few quick questions para mahanap ko agad ang best deal (no endless scrolling).`;
    await sendText(senderId, msg);
  }

  if (!info.payment) { await sendText(senderId, `Una: **Cash** ba o **Financing** ang plan mo? 🙂`); return; }
  if (!info.location) { await sendText(senderId, `Saan location ninyo? (city/province)`); return; }
  if (!info.body)     { await sendText(senderId, `May preferred **body type** ka ba? (sedan/suv/mpv/van/pickup — o ‘any’)`); return; }
  if (!info.trans)    { await sendText(senderId, `Transmission? (automatic / manual — pwede ring ‘any’)`); return; }

  if (info.payment === 'cash' && !info.budgetCash) {
    await sendText(senderId, `Magkano ang **cash budget range** mo? (e.g., 450k-600k o ‘below 600k’)`);
    return;
  }
  if (info.payment === 'financing' && !info.budgetAllIn) {
    await sendText(senderId, `Magkano ang **ready cash-out / all-in** range? (e.g., 150k-220k)`);
    return;
  }

  state.phase = 'offer';
  await sendText(senderId, `GOT IT! ✅ I’ll search the best matches now based on details mo.`);
  await doOffer(senderId, state);
}

async function doOffer(senderId, state) {
  const { info } = state;

  const params = {
    mode: info.payment,
    body: info.body === 'any' ? '' : info.body,
    trans: info.trans === 'any' ? '' : info.trans,
    city: info.location,
    model: info.model || '',
  };
  if (info.payment === 'cash' && info.budgetCash) {
    params.cashMin = info.budgetCash.min; params.cashMax = info.budgetCash.max;
  }
  if (info.payment === 'financing' && info.budgetAllIn) {
    params.allInMin = info.budgetAllIn.min; params.allInMax = info.budgetAllIn.max;
  }

  await sendTypingOn(senderId);
  let data;
  try {
    data = await queryInventory(params);
  } catch (e) {
    await sendTypingOff(senderId);
    await sendText(senderId, `Nagka-issue sa inventory search. Paki-try ulit in a moment 🙏`);
    return;
  }
  await sendTypingOff(senderId);

  const items = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) {
    await sendText(senderId, `Walang exact match. Okay bang **i-expand** natin ng konti ang budget o nearby cities para may maipakita ako?`);
    state.phase = 'qualify';
    return;
  }

  const top = pickTopTwo(items);
  if (!top.length) {
    await sendText(senderId, `Wala pang exact match. Gusto mo bang magbukas tayo ng ibang options (ibang model/body type)?`);
    state.phase = 'qualify';
    return;
  }

  await sendText(senderId, `Ito yung best na swak sa details mo (priority muna if available):`);
  for (let i = 0; i < top.length; i++) {
    const car = top[i];
    const img = car.image_1 || car.image1 || '';
    if (img) await sendImage(senderId, img);
    await sendText(senderId, shortCaption(car, i));
  }

  state.offered = top;
  state.phase = 'await_selection';
  await sendText(senderId, `If you like one, reply with **1** or **2** to see full photos. Kung gusto mong ibang options, sabihin mo lang (e.g., “ibang van” or “ibang model”).`);
}

async function sendFullPhotos(senderId, item) {
  const urls = [];
  for (let i = 1; i <= 10; i++) {
    const key = `image_${i}`;
    const v = item[key];
    if (v && typeof v === 'string' && v.startsWith('http')) urls.push(v);
  }
  if (!urls.length && item.image1) {
    for (let i = 1; i <= 10; i++) {
      const key = `image${i}`;
      if (item[key]) urls.push(item[key]);
    }
  }
  if (!urls.length) { await sendText(senderId, `Wala pang additional photos saved—pwede ko i-request sa dealer ngayon. ✅`); return; }
  await sendText(senderId, `Here are the full photos for your selected unit:`);
  for (const u of urls) await sendImage(senderId, u);
  await sendText(senderId, `Gusto mo ba i-schedule ang viewing? Sabihin mo lang “schedule viewing” kung ready ka.`);
}

// -------------- Messenger plumbing --------------
export default async function handler(req, res) {
  try {
    const method = req.method;
    if (method === 'GET') {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];
      if (mode === 'subscribe' && token === FB_VERIFY_TOKEN) {
        return res.status(200).send(challenge);
      }
      return res.status(403).send('Forbidden');
    }

    if (method === 'POST') {
      const body = typeof req.body === 'object' ? req.body
                  : (typeof req.json === 'function' ? await req.json() : {});
      if (!body || body.object !== 'page') return res.status(200).send('ok');

      for (const entry of body.entry || []) {
        for (const event of entry.messaging || []) {
          const senderId = event.sender?.id;
          if (!senderId) continue;

          await sendTypingOn(senderId);

          const text = event.message?.text || event.postback?.title || '';
          if (text && isRestart(text)) {
            resetState(senderId);
            await sendTypingOff(senderId);
            await sendText(senderId, `✅ New search started. Let’s begin fresh.`);
            const st = getState(senderId);
            await askNextQuestion(senderId, st);
            continue;
          }

          const state = getState(senderId);
          state.lastMsgTime = Date.now();

          if (!state.greetDone) {
            if (state.createdAt && Date.now() - state.createdAt > 60_000) {
              await sendText(senderId, `Welcome back! ✅ We can continue from last details, or say “restart” to start over.`);
            }
          }

          const choiceMatch = (event.message?.text || '').trim().match(/^\s*[#\[]?\s*(\d{1,2})\s*[\]\.]?\s*$/);
          if (state.phase === 'await_selection' && choiceMatch) {
            const idx = Number(choiceMatch[1]) - 1;
            const picked = state.offered[idx];
            if (picked) {
              await sendTypingOff(senderId);
              await sendFullPhotos(senderId, picked);
              state.phase = 'followup';
              continue;
            }
          }

          const msg = event.message?.text || '';
          if (msg) {
            if (!state.info.payment) { const p = detectPayment(msg); if (p) state.info.payment = p; }
            if (!state.info.body)     { const b = detectBody(msg);   if (b) state.info.body   = b; }
            if (!state.info.trans)    { const tr = detectTransmission(msg); if (tr) state.info.trans = tr; }
            if (!state.info.model)    { const mm = detectModel(msg); if (mm) state.info.model = mm; }

            if (!state.info.location) {
              if (/\bcity|province|qc|quezon|manila|makati|pasig|mandaluyong|taguig|cainta|cavite|laguna|bulacan|antipolo|paranaque|las pinas|valenzuela|caloocan|malabon|navotas/i.test(msg)) {
                state.info.location = msg.trim();
              }
            }

            if (state.info.payment === 'cash' && !state.info.budgetCash) {
              const r = extractBudgetRange(msg); if (r) state.info.budgetCash = r;
            } else if (state.info.payment === 'financing' && !state.info.budgetAllIn) {
              const r = extractBudgetRange(msg); if (r) state.info.budgetAllIn = r;
            }
          }

          if (state.phase === 'offer' || state.phase === 'await_selection' || state.phase === 'followup') {
            if (/ibang|other|more|iba pang|show more|ibang unit/i.test(msg)) {
              state.phase = 'offer'; state.offered = [];
              await doOffer(senderId, state);
            } else if (state.phase !== 'await_selection') {
              await askNextQuestion(senderId, state);
            }
          } else {
            await askNextQuestion(senderId, state);
          }

          await sendTypingOff(senderId);
        }
      }
      return res.status(200).send('ok');
    }

    return res.status(405).send('Method Not Allowed');
  } catch (err) {
    console.error('webhook error', err);
    try { return res.status(200).send('ok'); } catch {}
  }
}
