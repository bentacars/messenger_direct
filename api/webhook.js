// /api/webhook.js
import fetch from 'node-fetch';
import { pickTopTwo } from './lib/matching.js';
import { sendText, sendButtons, sendImage, sendImagesSequential } from './lib/messenger.js';

// ---------- ENV ----------
const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;
const INVENTORY_API = process.env.INVENTORY_API_URL;
const MODEL = process.env.MODEL || 'gpt-4.1';
const TEMPERATURE = Number(process.env.TEMPERATURE ?? 0.30);

// ---------- Simple in-memory session store ----------
const SESS = new Map();
/*
SESS.set(psid, {
  want: {payment, model, brand, body_type, transmission, cash_budget, cash_out, city, province},
  candidates: [row,row],
  pickedIndex: null
})
*/

// Minimal NLU helpers (keep it light for now)
function extractPickNumber(text) {
  const m = String(text).match(/\b(?:#?\s*(\d+)|number\s*(\d+))\b/i);
  if (!m) return null;
  const n = Number(m[1] || m[2]);
  return Number.isFinite(n) ? n : null;
}

// ---------- FB Webhook ----------
export default async function handler(req, res) {
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Verification failed');
  }

  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    const body = req.body;
    if (body.object !== 'page') return res.status(200).send('ignored');

    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        const psid = event.sender?.id;
        if (!psid) continue;

        if (event.message?.text) {
          await onMessage(psid, event.message.text.trim());
        } else if (event.postback?.payload) {
          await onMessage(psid, event.postback.payload.trim());
        }
      }
    }
    return res.status(200).send('ok');
  } catch (e) {
    console.error('webhook error', e);
    return res.status(500).send('webhook error');
  }
}

// ---------- Message flow ----------
async function onMessage(psid, text) {
  const state = SESS.get(psid) || { want: {}, candidates: [], pickedIndex: null };
  const lower = text.toLowerCase();

  // 1) Selection of preview: "1", "2", "number 2", "#2", etc.
  const pick = extractPickNumber(text);
  if (pick && state.candidates?.length) {
    const idx = pick - 1;
    if (idx >= 0 && idx < state.candidates.length) {
      const chosen = state.candidates[idx];
      // Send full gallery
      await sendText(psid, `Nice choice! 🔥 Sending full photos for:\n${prettyTitle(chosen)}`);
      if (chosen.images?.length) {
        await sendImagesSequential(psid, chosen.images);
      } else if (chosen.image_1) {
        await sendImage(psid, chosen.image_1);
      }
      await sendButtons(psid, "Gusto mo bang i-schedule ang viewing?", [
        { type: "postback", title: "Schedule viewing", payload: "SCHEDULE_VIEWING" },
        { type: "postback", title: "Show other units", payload: "SHOW_OTHERS" }
      ]);
      state.pickedIndex = idx;
      SESS.set(psid, state);
      return;
    }
  }

  // Postback buttons
  if (lower === 'schedule viewing' || lower === 'schedule_viewing' || lower === 'schedule viewing'.toLowerCase() || text === 'SCHEDULE_VIEWING') {
    await sendText(psid, "Got it! I-che-check ko ang available schedule today/tomorrow. Kindly send your full name and preferred day/time.");
    return;
  }
  if (lower === 'show other units' || text === 'SHOW_OTHERS') {
    await showOtherUnits(psid, state);
    return;
  }

  // 2) Update 'want' info from message (very light extraction)
  //    (We keep it compact—your qualifying already works; these are helpers.)
  updateWant(state.want, text);

  // 3) If we already have enough info OR user mentions a model explicitly → search
  const ready = isSearchReady(state.want) || looksLikeModel(text);
  if (ready) {
    const rows = await fetchInventory(state.want);
    const picks = pickTopTwo(rows, state.want);
    if (!picks.length) {
      await sendText(psid, "Walang exact match. Okay ba i-expand ng kaunti ang budget or nearby city para may maipakita ako?");
      SESS.set(psid, state);
      return;
    }

    // Save in session
    state.candidates = picks;
    SESS.set(psid, state);

    // 4) Send PREVIEW for two units (image_1 only)
    await sendText(psid, "Ito yung best na swak sa details mo:");
    for (let i = 0; i < picks.length; i++) {
      const p = picks[i];
      if (p.images?.length) await sendImage(psid, p.images[0]); // image_1
      const blurb = `${i + 1}️⃣ ${prettyTitle(p)}\nAll-in: ${peso(p.all_in) || '—'}\n${(p.city || '')} — ${p.mileage ? `${p.mileage} km` : ''}`;
      await sendText(psid, blurb);
    }
    await sendText(psid, "Anong number ang pipiliin mo?");
    return;
  }

  // 5) If not ready yet, keep qualifying lightly
  await sendText(psid, "Copy! Para tumama ang options, ano ang mas prefer mo — Cash or Financing?");
}

function prettyTitle(p) {
  return `${p.year || ''} ${p.brand || ''} ${p.model || ''} ${p.variant || ''}`.replace(/\s+/g,' ').trim();
}
function peso(n) {
  if (!Number.isFinite(n)) return null;
  return "₱" + n.toLocaleString('en-PH', { maximumFractionDigits: 0 });
}

// ---------- Helpers ----------
function looksLikeModel(text) {
  // simple cue: mentions common car words or looks like a model ask
  return /\b(mirage|vios|innova|fortuner|hiace|nv350|raize|brv|city|civic|accent|wigo|territory|stargazer|traviz|l300)\b/i.test(text);
}
function isSearchReady(want) {
  // any model or brand + a budget clue is typically enough
  if (want.model) return true;
  if (want.brand && (want.cash_budget || want.cash_out)) return true;
  return false;
}

function updateWant(want, text) {
  const t = text.toLowerCase();

  // payment
  if (/\bcash\b/i.test(text)) want.payment = "cash";
  if (/\bfinanc(e|ing|ing)\b|\bloan\b/i.test(text)) want.payment = "financing";

  // transmission
  if (/\bautomatic|at\b/i.test(text)) want.transmission = "automatic";
  if (/\bmanual|mt\b/i.test(text)) want.transmission = "manual";

  // body types
  if (/\bsedan\b/i.test(text)) want.body_type = "sedan";
  if (/\bsuv\b/i.test(text)) want.body_type = "suv";
  if (/\bhatch|hatchback\b/i.test(text)) want.body_type = "hatchback";
  if (/\bvan|nv350|hiace\b/i.test(text)) want.body_type = "van";

  // model & brand (simple picks)
  const models = ['mirage','vios','innova','fortuner','hiace','nv350','raize','brv','city','civic','accent','wigo','territory','stargazer','traviz','l300'];
  for (const m of models) if (t.includes(m)) want.model = m;

  const brands = ['toyota','mitsubishi','honda','nissan','hyundai','ford','isuzu','mg','geely','chery','suzuki','kia'];
  for (const b of brands) if (t.includes(b)) want.brand = b;

  // budget logic
  const money = text.match(/(?:₱|\bphp\b|)\s*\d[\d,]{4,}/i);
  if (money) {
    const val = Number(money[0].replace(/[^\d]/g,''));
    if (want.payment === "cash") want.cash_budget = val;
    else want.cash_out = val; // financing default
  }

  // location rough
  const mCity = text.match(/\b(?:qc|quezon|makati|pasig|manila|taguig|pasay|caloocan|valenzuela|mandaluyong|marikina|muntinlupa|parañaque)\b/i);
  if (mCity) want.city = mCity[0];
}

// Fetch inventory rows from your Apps Script JSON
async function fetchInventory(want) {
  const url = new URL(INVENTORY_API);
  // Soft filters (server returns all; we score client-side)
  if (want.model) url.searchParams.set('model', want.model);
  if (want.body_type) url.searchParams.set('body_type', want.body_type);
  if (want.transmission) url.searchParams.set('transmission', want.transmission);
  if (want.payment === 'cash' && want.cash_budget) url.searchParams.set('cash_budget', String(want.cash_budget));
  if (want.payment === 'financing' && want.cash_out) url.searchParams.set('cash_out', String(want.cash_out));

  const res = await fetch(url.toString(), { timeout: 15000 }).catch(() => null);
  if (!res || !res.ok) return [];
  const j = await res.json().catch(() => ({}));
  return Array.isArray(j.items) ? j.items : [];
}

async function showOtherUnits(psid, state) {
  // fallback: tell them you’ll search again (you can expand logic later)
  await sendText(psid, "Sige, maghahanap pa ako ng ibang options na pasok sa specs mo.");
  // You can fetch again with relaxed rules if you want.
}
