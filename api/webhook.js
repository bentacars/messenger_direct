// api/webhook.js
import {
  sendText,
  sendTypingOn,
  sendTypingOff,
  sendImage
} from './lib/messenger.js';
import {
  adaptTone,
  smartShort,
  remember,
  recall,
  forgetIfRestart,
  extractClues
} from './lib/llm.js';

const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;
const PAGE_TOKEN = process.env.FB_PAGE_TOKEN;
const INVENTORY_API_URL = process.env.INVENTORY_API_URL;

// simple in-memory store (will reset on cold starts)
const SESS = new Map();

function getSession(psid) {
  if (!SESS.has(psid)) {
    SESS.set(psid, {
      name: null,
      prefs: {
        plan: null,       // "cash" | "financing"
        city: null,
        body: null,       // sedan/suv/mpv/van/pickup/any
        trans: null,      // automatic/manual/any
        budgetMin: null,  // cash
        budgetMax: null,  // cash
        dpMin: null,      // financing
        dpMax: null,      // financing
        model: null,
        year: null
      },
      last: Date.now()
    });
  }
  return SESS.get(psid);
}

function normalize(s) {
  return (s || '').toString().trim().toLowerCase();
}

// ===== FB VERIFY (GET) =====
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const chall = searchParams.get('hub.challenge');
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return new Response(chall, { status: 200 });
  }
  return new Response('forbidden', { status: 403 });
}

// ===== MAIN WEBHOOK (POST) =====
export async function POST(req) {
  try {
    const body = await req.json();
    if (body.object !== 'page') return new Response('ignored', { status: 200 });

    for (const entry of body.entry || []) {
      for (const ev of entry.messaging || []) {
        const psid = ev.sender && ev.sender.id;
        if (!psid) continue;

        if (ev.message && ev.message.text) {
          await handleText(psid, ev.message.text);
        } else if (ev.postback && ev.postback.payload) {
          await handleText(psid, ev.postback.payload);
        }
      }
    }
    return new Response('ok', { status: 200 });
  } catch (e) {
    console.error('webhook error', e);
    return new Response('error', { status: 500 });
  }
}

// ===== CONVERSATION =====
const ASK_ORDER = ['plan', 'city', 'body', 'trans', 'budget']; // budget last

async function handleText(psid, raw) {
  const msg = normalize(raw);
  const session = getSession(psid);

  // restart
  if (await forgetIfRestart(msg, psid, session)) {
    await sendText(PAGE_TOKEN, psid, 'Sige, start tayo ulit.');
    return askNext(psid, session, true);
  }

  // quick gallery command
  const didGallery = await maybeGallery(psid, msg, session);
  if (didGallery) return;

  // clues (model/year/body hints)
  extractClues(msg, session);

  // greeting handling
  const wasSeen = !!recall(psid);
  remember(psid);
  if (/^(hi|hello|hey|good\s*(am|pm|day)|kumusta|hoy)\b/.test(msg)) {
    const line = wasSeen
      ? 'Welcome back! Ready ka bang maghanap ng unit ngayon?'
      : 'Hi! Tutulungan kitang ma-match sa best used car. 🙂';
    await sendText(PAGE_TOKEN, psid, smartShort(adaptTone(line, msg)));
    return askNext(psid, session, false);
  }

  // capture current answer
  await captureAnswer(psid, msg, session);

  // qualified? then fetch and offer; else keep asking
  if (isQualified(session)) {
    await sendTypingOn(PAGE_TOKEN, psid);
    const units = await findBestUnits(session);
    await sendTypingOff(PAGE_TOKEN, psid);

    if (!units.length) {
      await sendText(
        PAGE_TOKEN,
        psid,
        smartShort(adaptTone('Walang exact priority match, pero may malalapit na options. Ipapadala ko ang unang dalawa.', raw))
      );
    }

    await offerTopTwo(psid, units, session);
    await sendText(
      PAGE_TOKEN,
      psid,
      smartShort('Sabihin mo lang: "photos 1" o "photos 2" para sa full gallery. Pwede ring "iba pa" para sa alternatives.')
    );
  } else {
    await askNext(psid, session, false);
  }
}

async function captureAnswer(psid, msg, session) {
  const p = session.prefs;

  // plan
  if (!p.plan) {
    if (/\b(cash|spot\s*cash|cash\s*buyer)\b/.test(msg)) p.plan = 'cash';
    if (/\b(finance|financing|loan|installment|hulog)\b/.test(msg)) p.plan = 'financing';
  }

  // city
  if (!p.city) {
    const m = msg.match(/\b(qc|quezon city|manila|makati|pasig|pasay|mandaluyong|taguig|caloocan|valenzuela|marikina|muntinlupa|paranaque|las pinas|cebu|davao|iloilo|bacolod|pampanga|cavite|bulacan)\b/);
    if (m) p.city = m[0];
  }

  // body
  if (!p.body) {
    const bodyKeys = ['sedan','suv','mpv','van','pickup','pick-up','pick up','any'];
    const found = bodyKeys.find(k => msg.includes(k));
    if (found) p.body = found.replace('pick-up','pickup').replace('pick up','pickup');
    if (!p.body && /nv350|hiace|starex|traviz|urvan|vanette\b/.test(msg)) p.body = 'van';
    if (!p.body && /vios|city|mirage|altis|elantra|accent\b/.test(msg)) p.body = 'sedan';
    if (!p.body && /fortuner|everest|montero|terra|raize|cx-5|cr-v|ranger|hilux|strada|navara\b/.test(msg)) p.body = 'suv';
  }

  // transmission
  if (!p.trans) {
    if (/\b(automatic|at|a\/t)\b/.test(msg)) p.trans = 'automatic';
    if (/\b(manual|mt|m\/t|stick)\b/.test(msg)) p.trans = 'manual';
    if (/\bany\b/.test(msg)) p.trans = 'any';
  }

  // budget text to numbers
  if (!hasBudget(p)) {
    const range = msg.match(/(\d{2,3})\s*(?:-|–|to)\s*(\d{2,3})\s*k/i);
    if (range) {
      const a = Number(range[1]) * 1000;
      const b = Number(range[2]) * 1000;
      if (p.plan === 'cash') { p.budgetMin = Math.min(a,b); p.budgetMax = Math.max(a,b); }
      else { p.dpMin = Math.min(a,b); p.dpMax = Math.max(a,b); }
    }
    const under = msg.match(/\b(below|under|<=?)\s*(\d{2,3})\s*k\b/i);
    if (under) {
      const cap = Number(under[2]) * 1000;
      if (p.plan === 'cash') { p.budgetMin = 0; p.budgetMax = cap; }
      else { p.dpMin = 0; p.dpMax = cap; }
    }
  }
}

function hasBudget(p) {
  return p.plan === 'cash'
    ? (p.budgetMin != null || p.budgetMax != null)
    : (p.dpMin != null || p.dpMax != null);
}

function isQualified(session) {
  const p = session.prefs;
  return !!(p.plan && p.city && p.body && p.trans && hasBudget(p));
}

async function askNext(psid, session, welcome) {
  const p = session.prefs;

  if (welcome) {
    await sendText(PAGE_TOKEN, psid, smartShort('Let us match you to the best used car.'));
  }
  if (!p.plan) {
    return sendText(PAGE_TOKEN, psid, smartShort('Cash or financing ang plan mo?'));
  }
  if (!p.city) {
    return sendText(PAGE_TOKEN, psid, smartShort('Saan location mo? (city/province)'));
  }
  if (!p.body) {
    return sendText(PAGE_TOKEN, psid, smartShort('Preferred body type? (sedan/suv/mpv/van/pickup or "any")'));
  }
  if (!p.trans) {
    return sendText(PAGE_TOKEN, psid, smartShort('Transmission? (automatic / manual or "any")'));
  }
  if (!hasBudget(p)) {
    if (p.plan === 'cash') {
      return sendText(PAGE_TOKEN, psid, smartShort('Cash budget range? (e.g., 450k-600k or "below 600k")'));
    } else {
      return sendText(PAGE_TOKEN, psid, smartShort('Ready cash-out / all-in range? (e.g., 150k-220k)'));
    }
  }
}

async function fetchInventory() {
  const r = await fetch(INVENTORY_API_URL, { method: 'GET' });
  if (!r.ok) throw new Error('inventory ' + r.status);
  const j = await r.json();
  return j.items || j.rows || [];
}

function inRange(val, min, max) {
  if (val == null) return false;
  if (min != null && val < min) return false;
  if (max != null && val > max) return false;
  return true;
}

function chooseTopTwo(items, prefs) {
  const city = normalize(prefs.city || '');
  const body = normalize(prefs.body || 'any');
  const trans = normalize(prefs.trans || 'any');
  const isCash = prefs.plan === 'cash';

  const scored = items.map(x => {
    const price = isCash ? Number(x.srp || 0) : Number(x.all_in || 0);
    const bodyOk = (body === 'any') || (normalize(x.body_type || '') === body);
    const transOk = (trans === 'any') || (normalize(x.transmission || '') === trans);
    const cityHit = city && normalize(x.city || '') === city ? 1 : 0;
    const pri = /priority/i.test(x.price_status || '') ? 2 : 0;
    const modelHit = prefs.model && normalize(x.model || '') === normalize(prefs.model) ? 1 : 0;
    const yearHit = prefs.year && Number(x.year) === Number(prefs.year) ? 1 : 0;

    let score = 0;
    if (bodyOk) score += 2;
    if (transOk) score += 2;
    score += cityHit + modelHit + yearHit + pri;

    return { x, price, score, pri };
  });

  const budgetMin = isCash ? prefs.budgetMin : prefs.dpMin;
  const budgetMax = isCash ? prefs.budgetMax : prefs.dpMax;
  const filtered = scored.filter(s => inRange(s.price, budgetMin, budgetMax));
  const base = filtered.length ? filtered : scored;

  base.sort((a, b) => (b.pri - a.pri) || (b.score - a.score) || (a.price - b.price));
  return base.slice(0, 2).map(s => s.x);
}

async function findBestUnits(session) {
  const all = await fetchInventory();
  return chooseTopTwo(all, session.prefs);
}

function unitTitle(u) {
  const name = ([(u.year || ''), (u.brand || ''), (u.model || ''), (u.variant || '')]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim());
  const city = u.city || (u.province || '');
  const priceText = (u.all_in
    ? ('All-in: ₱' + Number(u.all_in).toLocaleString('en-PH'))
    : ('SRP: ₱' + Number(u.srp || 0).toLocaleString('en-PH')));
  const km = u.mileage ? (u.mileage.toLocaleString('en-PH') + ' km') : '';
  return '🚗 ' + name + '\n' + priceText + '\n' + city + (km ? (' — ' + km) : '');
}

async function offerTopTwo(psid, units, session) {
  if (!units.length) {
    await sendText(PAGE_TOKEN, psid, smartShort('Maghahanap pa ako ng lalabas na units sa budget mo. Pwede nating i-adjust ang filters mo.'));
    return;
  }
  const note = /priority/i.test(units[0]?.price_status || '')
    ? 'Ito yung best na swak sa details mo (priority muna).'
    : 'Ito yung best na swak sa details mo.';
  await sendText(PAGE_TOKEN, psid, smartShort(note));

  let i = 0;
  for (const u of units) {
    i += 1;
    if (u.image_1) await sendImage(PAGE_TOKEN, psid, u.image_1);
    await sendText(PAGE_TOKEN, psid, smartShort(unitTitle(u)));
  }

  await sendText(PAGE_TOKEN, psid, smartShort('Anong number ang gusto mong tingnan? Sabihin mo: "1" o "2".'));
}

async function maybeGallery(psid, msg, session) {
  const m = msg.match(/\bphotos?\s*(1|2)\b/);
  if (!m) return false;
  const index = Number(m[1]) - 1;
  const units = await findBestUnits(session);
  if (!units[index]) return false;
  const u = units[index];

  const imgs = [
    u.image_1, u.image_2, u.image_3, u.image_4, u.image_5,
    u.image_6, u.image_7, u.image_8, u.image_9, u.image_10
  ].filter(Boolean).slice(0, 10);

  await sendText(PAGE_TOKEN, psid, smartShort('Sige, here are more photos:'));
  for (const url of imgs) {
    await sendImage(PAGE_TOKEN, psid, url);
  }
  return true;
}
