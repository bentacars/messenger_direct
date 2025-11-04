// api/webhook.js (ESM)
import {
  sendText, sendTypingOn, sendTypingOff, sendImage, sendQuickReplies, validatePsid
} from './lib/messenger.js';

const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;
const INV_URL = process.env.INVENTORY_API_URL;

if (!VERIFY_TOKEN) console.warn('Missing FB_VERIFY_TOKEN');
if (!INV_URL) console.warn('Missing INVENTORY_API_URL');

// -------------------- Simple in-memory session store --------------------
const SESS = new Map(); // key: psid => state

function newState() {
  return {
    step: 'plan',           // plan -> city -> body -> trans -> budget -> offer
    plan: null,             // 'cash' | 'financing'
    city: null,             // string
    body: null,             // sedan/suv/mpv/van/pickup/any
    trans: null,            // automatic/manual/any
    budget: null,           // number-ish or range text
    lastOffers: [],         // [{idx, item}]
  };
}

function getState(psid) {
  if (!SESS.has(psid)) SESS.set(psid, newState());
  return SESS.get(psid);
}

function reset(psid) { SESS.set(psid, newState()); }

// -------------------- Utils --------------------
const peso = n =>
  `₱${Number(n).toLocaleString('en-PH', { maximumFractionDigits: 0 })}`;

const ceil5k = n => Math.ceil(Number(n) / 5000) * 5000;

function niceShortPeso(n) {
  const v = Number(n);
  if (v >= 1000 && v < 1000000) {
    const k = Math.round(v / 1000);
    return `₱${k}K`;
  }
  return peso(v);
}

function parseBudget(text) {
  // return max value for cash/all-in budget
  const m = (text || '').replace(/[,₱ ]/g, '').match(/(\d{2,7})/g);
  if (!m) return null;
  const nums = m.map(Number).sort((a,b)=>a-b);
  return nums[nums.length-1] || null;
}

function norm(s) { return String(s || '').trim().toLowerCase(); }

// -------------------- Inventory fetch & match --------------------
async function fetchInventory() {
  const u = `${INV_URL}?pretty=0`;
  const res = await fetch(u);
  const j = await res.json();
  if (!j || !j.items) throw new Error('Bad inventory payload');
  return j.items;
}

function itemHasImages(item) {
  for (let i = 1; i <= 10; i++) {
    const key = `image_${i}`;
    if (item[key]) return true;
  }
  return false;
}

function scoreItem(it, st) {
  // base matching score; higher is better
  let sc = 0;
  if (st.body && norm(it.body_type) === norm(st.body)) sc += 3;
  if (st.trans && norm(it.transmission) === norm(st.trans)) sc += 2;
  if (st.city && norm(it.city) === norm(st.city)) sc += 2;
  // budget check
  const srp = Number(it.srp || it.cash_price || 0);
  const allin = Number(it.price_all_in || it.all_in || 0);
  if (st.plan === 'cash' && st.budget && srp && srp <= st.budget) sc += 3;
  if (st.plan === 'financing' && st.budget && allin && allin <= st.budget) sc += 3;
  if (itemHasImages(it)) sc += 1;

  // light boost for recent / lower mileage
  const km = Number(it.mileage || 0);
  if (km && km < 30000) sc += 1;

  // Priority gets a big boost but we’ll still hard-sort later
  if (norm(it.price_status) === 'priority') sc += 5;

  return sc;
}

function pickPriceLines(item, plan) {
  const cityTxt = item.city || (item.complete_address || '').split(',')[0] || '—';
  const kmTxt = item.mileage ? `${Number(item.mileage).toLocaleString()} km` : '—';

  if (plan === 'cash') {
    const srp = Number(item.srp || item.cash_price || 0);
    if (!srp) return `SRP: (ask)\n${cityTxt} — ${kmTxt}`;
    return `SRP: ${peso(srp)} (negotiable upon viewing)\n${cityTxt} — ${kmTxt}`;
  }

  // financing
  const rawAllIn = Number(item.price_all_in || item.all_in || 0);
  if (!rawAllIn) return `All-in: (ask)\n${cityTxt} — ${kmTxt}`;

  const low = ceil5k(rawAllIn);
  const hi = low + 20000;
  return [
    `All-in: ${peso(low)}–${peso(hi)} (negotiable & subject for approval — promo this month)`,
    `Standard is ~20% DP of the unit price.`,
    `${cityTxt} — ${kmTxt}`
  ].join('\n');
}

function formatTitle(item) {
  const year = item.year || '';
  const brand = item.brand || '';
  const model = item.model || '';
  const variant = item.variant || '';
  return `🚗 ${year} ${brand} ${model} ${variant}`.replace(/\s+/g,' ').trim();
}

function primaryImage(item) {
  return item.image_1 || item.image_2 || item.image_3 || item.image_4 || item.image_5 || '';
}

function allImages(item) {
  const arr = [];
  for (let i = 1; i <= 10; i++) {
    const k = `image_${i}`;
    if (item[k]) arr.push(item[k]);
  }
  return arr;
}

// -------------------- Conversation flow helpers --------------------
async function askPlan(psid, isNew) {
  await sendText(psid, isNew
    ? `Hi! 👋 I’m your BentaCars consultant. Tutulungan kitang ma-match sa best unit para di ka na mag-scroll nang mag-scroll.`
    : `Reset na. Let’s start fresh. 🙂`);
  await sendText(psid, `Cash or financing ang plan mo?`);
}

async function askCity(psid) {
  await sendText(psid, `Saan location mo? (city/province)`);
}

async function askBody(psid) {
  await sendText(psid, `Anong body type hanap mo? (sedan/suv/mpv/van/pickup — or type 'any')`);
}

async function askTrans(psid) {
  await sendText(psid, `Auto or manual? (pwede rin 'any')`);
}

async function askBudget(psid, plan) {
  if (plan === 'cash') {
    await sendText(psid, `Cash budget range? (e.g., 450k–600k)`);
  } else {
    await sendText(psid, `All-in (ready cash-out) budget? (e.g., 90k–120k)`);
  }
}

async function showOffers(psid, st) {
  const items = await fetchInventory();

  // Candidate set: filter lightly first
  const cand = items.filter(it => {
    if (st.body && norm(st.body) !== 'any' && norm(it.body_type) !== norm(st.body)) return false;
    if (st.trans && norm(st.trans) !== 'any' && norm(it.transmission) !== norm(st.trans)) return false;

    // Budget filter depends on plan
    if (st.budget) {
      if (st.plan === 'cash') {
        const srp = Number(it.srp || it.cash_price || 0);
        if (!srp || srp > st.budget) return false;
      } else {
        const allin = Number(it.price_all_in || it.all_in || 0);
        if (!allin || allin > st.budget) return false;
      }
    }
    return true;
  });

  if (!cand.length) {
    await sendText(psid, `Walang exact match sa filters mo. Pwede nating i-adjust konti (budget or body type) para may maipakita ako. Type **others** para i-relax natin.`);
    return;
  }

  // Compute scores
  cand.forEach(it => { it.__score = scoreItem(it, st); });

  // Sort: Priority first, then score
  const prio = cand.filter(it => norm(it.price_status) === 'priority')
                   .sort((a,b)=>b.__score - a.__score);
  const rest = cand.filter(it => norm(it.price_status) !== 'priority')
                   .sort((a,b)=>b.__score - a.__score);

  // Take 2 overall, preferring priority but fallback to rest
  const top = [...prio.slice(0,2)];
  if (top.length < 2) top.push(...rest.slice(0, 2 - top.length));

  if (!top.length) {
    await sendText(psid, `Walang priority na pasok, pero may ibang options. Type **others** para ipakita ko sila.`);
    return;
  }

  // Send two cards (image_1 + short text) then quick replies 1/2/others
  for (const item of top) {
    const img = primaryImage(item);
    if (img) await sendImage(psid, img);
    await sendText(psid, `${formatTitle(item)}\n${pickPriceLines(item, st.plan)}`);
  }

  // Save mapping so we can resolve "1"/"2"
  st.lastOffers = top.map((it, i) => ({ idx: i+1, item: it }));

  await sendQuickReplies(psid, `Pili ka: 1 or 2. Gusto mo ring **full photos**? Type **more 1** or **more 2**. Need more options? Type **others**.`, [
    { title: '1', payload: 'PICK_1' },
    { title: '2', payload: 'PICK_2' },
    { title: 'Others', payload: 'OTHERS' },
  ]);
}

// -------------------- Vercel handler --------------------
export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      // FB webhook verification
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];
      if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
      }
      return res.status(403).send('Forbidden');
    }

    if (req.method !== 'POST') {
      return res.status(405).send('Method Not Allowed');
    }

    const body = await getBody(req);
    if (body.object !== 'page') return res.status(200).send('ok');

    for (const entry of body.entry || []) {
      for (const ev of entry.messaging || []) {
        if (!ev.sender || !ev.sender.id) continue;
        const psid = validatePsid(String(ev.sender.id));

        if (ev.message && ev.message.text) {
          await handleMessage(psid, ev.message.text);
        } else if (ev.postback && ev.postback.payload) {
          await handleMessage(psid, ev.postback.payload);
        }
      }
    }
    res.status(200).send('EVENT_RECEIVED');
  } catch (err) {
    console.error('webhook error', err);
    res.status(200).send('ok'); // Never drop the webhook
  }
}

// Vercel Node helper to read JSON
async function getBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const bufs = [];
  for await (const chunk of req) bufs.push(chunk);
  const raw = Buffer.concat(bufs).toString('utf8');
  try { return JSON.parse(raw); } catch { return {}; }
}

// -------------------- Message router --------------------
async function handleMessage(psid, rawText) {
  const text = norm(rawText);
  const st = getState(psid);

  // restart
  if (text === 'restart' || text === 'reset' || text === 'start over') {
    reset(psid);
    await askPlan(psid, false);
    return;
  }

  // Natural “hello” / chit-chat won’t break flow
  const greetings = ['hi','hello','helo','yo','hey','kumusta','good am','good pm','gandang araw'];
  if (greetings.includes(text) && st.step === 'plan') {
    await askPlan(psid, true);
    return;
  }

  await sendTypingOn(psid);

  // flow steps
  if (st.step === 'plan') {
    if (text.includes('cash')) st.plan = 'cash';
    else if (text.includes('finance')) st.plan = 'financing';
    if (!st.plan) {
      await sendText(psid, `Cash or financing ang plan mo?`);
      await sendTypingOff(psid);
      return;
    }
    st.step = 'city';
    await askCity(psid);
    await sendTypingOff(psid);
    return;
  }

  if (st.step === 'city') {
    st.city = rawText.trim();
    st.step = 'body';
    await askBody(psid);
    await sendTypingOff(psid);
    return;
  }

  if (st.step === 'body') {
    st.body = text || 'any';
    st.step = 'trans';
    await askTrans(psid);
    await sendTypingOff(psid);
    return;
  }

  if (st.step === 'trans') {
    if (text.startsWith('auto')) st.trans = 'automatic';
    else if (text.startsWith('man')) st.trans = 'manual';
    else st.trans = 'any';
    st.step = 'budget';
    await askBudget(psid, st.plan);
    await sendTypingOff(psid);
    return;
  }

  // “more 1/2”, “others”, “1/2” handling is allowed any time after offers
  if (/^more\s*[12]$/.test(text)) {
    const pick = Number(text.replace(/[^\d]/g,''));
    const found = (st.lastOffers || []).find(x => x.idx === pick);
    if (found) {
      const imgs = allImages(found.item);
      if (imgs.length) {
        for (const u of imgs) await sendImage(psid, u);
      } else {
        await sendText(psid, `Wala pang full gallery for this unit. Gusto mo bang i-schedule ang viewing?`);
      }
    } else {
      await sendText(psid, `Sige, pero piliin mo muna yung **1** or **2** sa latest options.`);
    }
    await sendTypingOff(psid);
    return;
  }

  if (text === 'others' || text === 'other' || text === 'more') {
    // relax filters just a bit: ignore city & body constraints, keep plan/budget/trans
    const loose = { ...st, body: null, city: null };
    await showOffers(psid, loose);
    await sendTypingOff(psid);
    return;
  }

  if (/^[12]$/.test(text)) {
    const num = Number(text);
    const found = (st.lastOffers || []).find(x => x.idx === num);
    if (found) {
      const { item } = found;
      await sendText(psid, `Nice pick! ${formatTitle(item)}\n${pickPriceLines(item, st.plan)}\n\nGusto mo bang i-schedule ang viewing? (yes/no)\nPwede ring i-type **more ${num}** para sa full photos.`);
      st.step = 'offer';
      await sendTypingOff(psid);
      return;
    }
  }

  if (st.step === 'budget') {
    st.budget = parseBudget(text);
    st.step = 'offer';
    await showOffers(psid, st);
    await sendTypingOff(psid);
    return;
  }

  // lightweight yes/no after pick
  if (st.step === 'offer') {
    if (text === 'yes' || text === 'yup' || text === 'oo' || text === 'sige') {
      await sendText(psid, `Great! Iche-check ko ang nearest branch for viewing schedule. What day/time works for you?`);
      await sendTypingOff(psid);
      return;
    }
    if (text === 'no' || text === 'ayaw' || text === 'pass') {
      await sendText(psid, `Noted. Gusto mo bang makita pa ibang options? Type **others**.`);
      await sendTypingOff(psid);
      return;
    }
  }

  // fallback: gentle nudge based on current step
  const stepMsg = {
    city: `Saan location mo? (city/province)`,
    body: `Anong body type hanap mo? (sedan/suv/mpv/van/pickup — or 'any')`,
    trans: `Auto or manual? (pwede rin 'any')`,
    budget: st.plan === 'cash' ? `Cash budget range? (e.g., 450k–600k)` : `All-in (ready cash-out) budget? (e.g., 90k–120k)`
  };
  await sendText(psid, stepMsg[st.step] || `Type **restart** to start over, or **others** for more options.`);
  await sendTypingOff(psid);
}
