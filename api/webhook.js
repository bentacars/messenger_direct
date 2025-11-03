// api/webhook.js
// Messenger webhook with restart flow, qualifying, and 2-offer (Priority-first) matching.
// Uses Google Apps Script endpoint via INVENTORY_API_URL and sends galleries for selected units.

import {
  sendText,
  sendQuickReplies,
  sendImage,
  sendGallery,
  buildImageElements,
  isRestart,
  isGreeting,
} from './lib/messenger.js';

// ===== Env =====
const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;
const INVENTORY_API_URL = process.env.INVENTORY_API_URL;

// (Optional model/temperature if you later plug LLM again)
const MODEL_DEFAULT = process.env.MODEL_DEFAULT || 'gpt-4.1';
const TEMP_DEFAULT = Number(process.env.TEMP_DEFAULT || '0.30');

// ===== Sessions (simple in-memory) =====
const sessions = new Map();
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4h

function freshSession() {
  return {
    phase: 'qualifying',
    collected: {
      // payment: 'cash' | 'financing' | 'undecided'
      // budget_cash: number
      // downpayment: number
      // location: 'Quezon City' / 'Cebu' ...
      // model: 'Vios' / 'NV350' ...
      // transmission: 'AT' | 'MT' (optional)
      // body_type: 'Sedan'/'SUV'/'MPV'... (optional)
    },
    last: Date.now(),
    offerShown: false,
    lastMatches: [],
    page: 0, // for pagination if needed later
  };
}

function getSession(senderId) {
  let s = sessions.get(senderId);
  if (!s || Date.now() - s.last > SESSION_TTL_MS) {
    s = freshSession();
    sessions.set(senderId, s);
  }
  return s;
}
function resetSession(senderId) {
  const s = freshSession();
  sessions.set(senderId, s);
  return s;
}

// ===== Utilities =====
function lower(s) { return (s || '').toString().trim().toLowerCase(); }
function num(x) {
  if (x === null || x === undefined) return null;
  const m = (x + '').replace(/[^\d.]/g, '');
  const n = Number(m);
  return Number.isFinite(n) ? n : null;
}

function parsePayload(entry) {
  const messaging = entry.messaging?.[0];
  if (!messaging) return {};
  const senderId = messaging.sender?.id;
  const text = messaging.message?.text;
  const postbackPayload = messaging.postback?.payload;
  const quickPayload = messaging.message?.quick_reply?.payload;
  const payload = postbackPayload || quickPayload || null;
  return { senderId, text, payload, raw: messaging };
}

// ===== Qualifying prompts =====
async function askPayment(senderId) {
  await sendQuickReplies(senderId, "Una: Cash ba o Financing ang plan mo? 🙂", [
    { title: "Cash", payload: "PAYMENT_CASH" },
    { title: "Financing", payload: "PAYMENT_FINANCING" },
    { title: "Undecided", payload: "PAYMENT_UNDECIDED" },
  ]);
}
async function askBudgetCash(senderId) {
  await sendText(senderId, "Magkano ang budget range mo (cash)? Hal: ₱450k to ₱600k.");
}
async function askDownpayment(senderId) {
  await sendText(senderId, "Magkano ang ready cash out (downpayment)? Hal: ₱150k.");
}
async function askLocation(senderId) {
  await sendText(senderId, "Saan location ninyo? (city/province)");
}
async function askModel(senderId) {
  await sendText(senderId, "May preferred model ka ba? (Hal: Vios, NV350). Puwede ring 'any sedan/SUV'.");
}
async function askTransmission(senderId) {
  await sendQuickReplies(senderId, "Transmission?", [
    { title: "Automatic", payload: "TX_AT" },
    { title: "Manual", payload: "TX_MT" },
    { title: "Any", payload: "TX_ANY" },
  ]);
}

// Check if we’ve collected enough to search
function hasEnough(col) {
  const havePayment = !!col.payment;
  const haveBudget =
    (col.payment === 'cash' && (col.budget_cash_min || col.budget_cash_max)) ||
    (col.payment === 'financing' && col.downpayment);
  const haveLocation = !!col.location;
  // model/transmission/body_type optional
  return havePayment && haveBudget && haveLocation;
}

// Try to auto-extract numbers from free text like "around 500k" or "120-150k"
function extractBudget(text) {
  const t = (text || '').toLowerCase();
  // range: "500k-700k", "500k to 700k"
  const reRange = /(\d[\d,.]*)\s*(k|m)?\s*(?:-|to|–|—)\s*(\d[\d,.]*)\s*(k|m)?/i;
  const rr = t.match(reRange);
  if (rr) {
    const a = rr[1], b = rr[3];
    const am = rr[2] || '', bm = rr[4] || '';
    const min = scale(a, am), max = scale(b, bm);
    return { min, max };
  }
  // single: "600k"
  const reOne = /(\d[\d,.]*)\s*(k|m)?/i;
  const r1 = t.match(reOne);
  if (r1) {
    const v = scale(r1[1], r1[2] || '');
    return { min: v, max: null };
  }
  return {};
  function scale(v, suf) {
    let n = Number((v + '').replace(/[^\d.]/g, ''));
    if (!Number.isFinite(n)) return null;
    if (suf === 'k') n = n * 1_000;
    if (suf === 'm') n = n * 1_000_000;
    return Math.round(n);
  }
}

// ===== Inventory fetch + match =====
async function fetchInventory() {
  const res = await fetch(INVENTORY_API_URL, { method: 'GET', headers: { 'Cache-Control': 'no-cache' } });
  if (!res.ok) throw new Error(`Inventory HTTP ${res.status}`);
  const data = await res.json();
  // expect { ok:true, items:[...] } from Apps Script
  return Array.isArray(data.items) ? data.items : [];
}

function scoreAndPick(items, col) {
  // Minimal filters:
  const pay = col.payment; // 'cash' | 'financing' | 'undecided'
  const tx = (col.transmission || 'any').toLowerCase();
  const wantModel = lower(col.model || '');
  const loc = lower(col.location || '');

  let filtered = items.filter(it => {
    // lock_flag 'Y' means hidden?
    if (String(it.lock_flag || '').toUpperCase() === 'Y') return false;

    // pricing
    if (pay === 'cash') {
      const price = num(it.srp);
      const min = col.budget_cash_min || 0;
      const max = col.budget_cash_max || Infinity;
      if (price && (price < min || price > max)) return false;
    } else if (pay === 'financing') {
      const allIn = num(it.all_in);
      const dp = col.downpayment ? Number(col.downpayment) : 0;
      if (allIn && dp && allIn > dp) return false; // require DP >= all-in (rough check)
    }

    // transmission (optional)
    if (tx !== 'any') {
      const invTx = lower(it.transmission || '');
      const want = tx === 'at' ? 'a' : 'm';
      if (!(invTx.includes('a') && want === 'a') && !(invTx.includes('m') && want === 'm')) {
        return false;
      }
    }

    // preferred model (optional, very soft)
    if (wantModel) {
      const joined = `${it.brand || ''} ${it.model || ''} ${it.variant || ''}`.toLowerCase();
      if (!joined.includes(wantModel)) return false;
    }

    // location soft filter (we keep for scoring)
    return true;
  });

  // Score: Priority first, then closeness to location (contains), then mileage low, then newest year
  filtered = filtered.map(it => {
    let score = 0;
    const status = (it.price_status || '').toLowerCase();
    if (status.includes('priority')) score += 1000;

    if (loc) {
      const locJoined = `${it.city || ''} ${it.province || ''} ${it.complete_address || ''}`.toLowerCase();
      if (locJoined.includes(loc)) score += 50;
    }

    const mileage = num(it.mileage) || 0;
    score += Math.max(0, 500 - Math.min(500, mileage / 100)); // crude: lower mileage => higher

    const year = Number(it.year || 0);
    score += Math.max(0, (year - 2000)); // newer a bit higher

    return { ...it, __score: score };
  });

  filtered.sort((a, b) => b.__score - a.__score);

  // Return top 2
  return filtered.slice(0, 2);
}

function titleLine(it) {
  const yr = it.year ? `${it.year} ` : '';
  const name = `${yr}${it.brand || ''} ${it.model || ''} ${it.variant || ''}`.replace(/\s+/g, ' ').trim();
  return `🚗 ${name}`;
}
function priceLine(it, col) {
  if (col.payment === 'cash') {
    const p = num(it.srp);
    return `Cash: ₱${(p || 0).toLocaleString('en-PH')}`;
  }
  const a = num(it.all_in);
  return `All-in: ₱${(a || 0).toLocaleString('en-PH')}`;
}
function metaLine(it) {
  const city = it.city || it.province || '';
  const km = num(it.mileage);
  const kmTxt = Number.isFinite(km) ? `${km.toLocaleString('en-PH')} km` : '';
  return `${city}${kmTxt ? ` — ${kmTxt}` : ''}`;
}

// ===== Offer flow =====
async function sendTwoOffers(senderId, matches, col, session) {
  if (!matches.length) {
    await sendText(
      senderId,
      "Walang exact match. Okay ba i-expand ng kaunti ang budget o nearby cities para may maipakita ako?"
    );
    return;
  }

  await sendText(senderId, "Ito yung best na swak sa details mo (priority muna).");

  // Send one-by-one: image_1 and caption per unit
  for (const it of matches) {
    const img = it.image_1 || it.image1 || it.image || null;
    if (img) {
      await sendImage(senderId, img);
    }
    const msg = `${titleLine(it)}\n${priceLine(it, col)}\n${metaLine(it)}`;
    await sendText(senderId, msg);
  }

  // Save matches for later “More photos / Select”
  session.lastMatches = matches;
  session.offerShown = true;
  session.last = Date.now();

  // Build quick replies for selection
  const qrs = matches.map((it, idx) => ({
    title: `${(it.year || '').toString()} ${it.brand || ''} ${it.model || ''}`.trim().slice(0, 20) || `Option ${idx + 1}`,
    payload: `SELECT_UNIT:${it.SKU || it.sku || `IDX${idx}`}`,
  }));
  qrs.push({ title: "Show other units", payload: "SHOW_OTHERS" });
  qrs.push({ title: "Start over", payload: "RESTART" });

  await sendQuickReplies(senderId, "Anong pipiliin mo?", qrs);
}

// Find by SKU from session
function findBySku(session, sku) {
  return (session.lastMatches || []).find(u => {
    const a = String(u.SKU || u.sku || '').trim();
    return a && a === sku;
  });
}

// ===== Main Handler =====
export default async function handler(req) {
  try {
    // ----- GET: webhook verification -----
    if (req.method === 'GET') {
      const { searchParams } = new URL(req.url);
      const mode = searchParams.get('hub.mode');
      const token = searchParams.get('hub.verify_token');
      const challenge = searchParams.get('hub.challenge');
      if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
      }
      return new Response('Forbidden', { status: 403 });
    }

    // ----- POST: incoming message -----
    const body = await req.json().catch(() => null);
    if (!body?.entry?.length) return new Response('no entry', { status: 200 });

    for (const entry of body.entry) {
      const { senderId, text, payload } = parsePayload(entry);
      if (!senderId) continue;

      const session = getSession(senderId);
      session.last = Date.now();

      // Restart / greeting reset
      const tnorm = (text || '').trim();
      if (isRestart(tnorm) || (isGreeting(tnorm) && (session.offerShown || session.phase !== 'qualifying'))) {
        resetSession(senderId);
        await sendText(senderId, "Sige! 🔄 Fresh start tayo. Consultant mode—goal natin: ma-match ka sa best unit (no endless scrolling).");
        await askPayment(senderId);
        continue;
      }

      // ---- Handle quick reply / postbacks first ----
      if (payload) {
        if (payload === 'PAYMENT_CASH') {
          session.collected.payment = 'cash';
          await sendText(senderId, "Got it: Cash ✅");
          await askBudgetCash(senderId);
          continue;
        }
        if (payload === 'PAYMENT_FINANCING') {
          session.collected.payment = 'financing';
          await sendText(senderId, "Got it: Financing ✅");
          await askDownpayment(senderId);
          continue;
        }
        if (payload === 'PAYMENT_UNDECIDED') {
          session.collected.payment = 'undecided';
          await sendText(senderId, "Sige, puwede tayong mag-compare.");
          // We’ll still ask model + location—then we can show options
          await askLocation(senderId);
          continue;
        }

        if (payload === 'TX_AT') { session.collected.transmission = 'AT'; await askModel(senderId); continue; }
        if (payload === 'TX_MT') { session.collected.transmission = 'MT'; await askModel(senderId); continue; }
        if (payload === 'TX_ANY') { session.collected.transmission = 'ANY'; await askModel(senderId); continue; }

        if (payload?.startsWith('SELECT_UNIT:')) {
          const sku = payload.split(':')[1];
          const unit = findBySku(session, sku);
          if (unit) {
            const urls = [
              unit.image_1, unit.image_2, unit.image_3, unit.image_4, unit.image_5,
              unit.image_6, unit.image_7, unit.image_8, unit.image_9, unit.image_10
            ].filter(Boolean);

            if (urls.length) {
              await sendGallery(senderId, buildImageElements(urls));
            } else {
              await sendText(senderId, "Walang extra photos sa record, pero puwede tayong mag-request sa dealer. 🙂");
            }

            await sendQuickReplies(senderId, "Anong next gusto mo?", [
              { title: "Schedule viewing", payload: `SCHEDULE:${sku}` },
              { title: "Show other units", payload: "SHOW_OTHERS" },
              { title: "Start over", payload: "RESTART" },
            ]);
          } else {
            await sendText(senderId, "Di ko mahanap yung unit na ’yon. Puwede mong piliin ulit o mag-show other units tayo. 🙂");
          }
          continue;
        }

        if (payload?.startsWith('MORE_PHOTOS:')) {
          const sku = payload.split(':')[1];
          const unit = findBySku(session, sku);
          if (unit) {
            const urls = [
              unit.image_1, unit.image_2, unit.image_3, unit.image_4, unit.image_5,
              unit.image_6, unit.image_7, unit.image_8, unit.image_9, unit.image_10
            ].filter(Boolean);
            if (urls.length) {
              await sendGallery(senderId, buildImageElements(urls));
            } else {
              await sendText(senderId, "Walang extra photos sa record, pero puwede tayong mag-request sa dealer. 🙂");
            }
          }
          continue;
        }

        if (payload === 'SHOW_OTHERS') {
          // For now, just prompt them to refine; pagination can be added later
          await sendText(senderId, "Sige! Refine natin. May ibang model ka bang gusto o i-adjust natin ang budget/location?");
          continue;
        }

        if (payload === 'RESTART') {
          resetSession(senderId);
          await sendText(senderId, "Reset done. 🔄");
          await askPayment(senderId);
          continue;
        }
      }

      // ---- Free-text path (qualification) ----
      if (session.phase === 'qualifying') {
        const col = session.collected;

        // Heuristics: detect budget / dp
        if (col.payment === 'cash') {
          const b = extractBudget(text);
          if (b.min || b.max) {
            col.budget_cash_min = b.min || null;
            col.budget_cash_max = b.max || null;
            await sendText(senderId, "Noted ang cash budget. ✅");
            if (!col.location) { await askLocation(senderId); continue; }
          }
        } else if (col.payment === 'financing') {
          const dp = extractBudget(text).min || num(text);
          if (dp) {
            col.downpayment = dp;
            await sendText(senderId, "Noted ang ready downpayment. ✅");
            if (!col.location) { await askLocation(senderId); continue; }
          }
        }

        // If looks like a location (contains city/province keywords), capture
        const t = lower(text);
        if (!col.location && /city|quezon|manila|cebu|davao|laguna|bulacan|cavite|rizal|pampanga|iloilo|bacolod|quezon city|makati|pasig|taguig|pasay|mandaluyong/i.test(text || '')) {
          col.location = text.trim();
          await sendText(senderId, `Got it, location: ${col.location} ✅`);
        }

        // Model preferences (any short word that matches common models)
        if (!col.model && /\b(vios|mirage|innova|fortuner|terrav?a|nv350|urvan|hiace|traviz|city|civic|almera|br-v|xpander|stargazer|vios xle|wigo|raize|brio|crosswind|accent)\b/i.test(text || '')) {
          col.model = text.trim();
          await sendText(senderId, `Noted sa preferred model: ${col.model} ✅`);
        }

        // Transmission mention
        if (!col.transmission && /\b(at|automatic|auto)\b/i.test(t)) {
          col.transmission = 'AT';
        } else if (!col.transmission && /\b(mt|manual)\b/i.test(t)) {
          col.transmission = 'MT';
        }

        // Ask next missing field in a friendly order
        if (!col.payment) { await askPayment(senderId); continue; }
        if (col.payment === 'cash' && !(col.budget_cash_min || col.budget_cash_max)) { await askBudgetCash(senderId); continue; }
        if (col.payment === 'financing' && !col.downpayment) { await askDownpayment(senderId); continue; }
        if (!col.location) { await askLocation(senderId); continue; }
        if (!col.transmission) { await askTransmission(senderId); continue; }
        if (!col.model) { await askModel(senderId); continue; }

        // We have enough—search
        if (hasEnough(col)) {
          await sendText(senderId, "GOT IT! ✅ I now have everything I need. I can now search available units for you.");
          // Fetch + match
          try {
            const all = await fetchInventory();
            const picks = scoreAndPick(all, col);
            await sendTwoOffers(senderId, picks, col, session);
            session.phase = 'offer';
          } catch (e) {
            console.error('Inventory error', e);
            await sendText(senderId, "Nagka-issue sa inventory lookup. Subukan natin ulit mamaya.");
          }
        }
        continue;
      }

      // ---- Offer phase free text (e.g., "more photos", "schedule", "iba pa") ----
      if (session.phase === 'offer') {
        const t = lower(text);
        if (/more|photos|pictures|pics|images|kuha|kuha pa/i.test(t)) {
          // If only one last match, show its gallery; else ask them to pick first
          const one = session.lastMatches?.[0];
          if (one) {
            const urls = [
              one.image_1, one.image_2, one.image_3, one.image_4, one.image_5,
              one.image_6, one.image_7, one.image_8, one.image_9, one.image_10
            ].filter(Boolean);
            if (urls.length) await sendGallery(senderId, buildImageElements(urls));
          } else {
            await sendText(senderId, "Please tap the unit you like para ma-show ko ang full gallery. 🙂");
          }
          continue;
        }
        if (/schedule|view|tingin|site|test drive|testdrive/i.test(t)) {
          await sendText(senderId, "Sige! Paki-send ng preferred day/time at full name. Iche-check ko agad availability ng unit sa branch. 🙂");
          continue;
        }
        if (/iba|other|more options|show other/i.test(t)) {
          await sendText(senderId, "Copy! Refine natin—may model ka bang gusto pa o adjust natin budget/location?");
          continue;
        }
      }
    }

    return new Response('ok', { status: 200 });
  } catch (err) {
    console.error('webhook error', err);
    return new Response('error', { status: 200 });
  }
}
