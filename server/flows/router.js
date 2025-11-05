// /server/flows/router.js
// Central conversation router: Phase 1 (qualifiers, human tone) → Phase 2 (offers) → Phase 3 (cash/financing)

import * as Qualifier from './qualifier.js';
import * as Offers from './offers.js';
import * as CashFlow from './cash.js';
import * as FinancingFlow from './financing.js';

const MEMORY_TTL_DAYS = Number(process.env.MEMORY_TTL_DAYS || 7);

/* ========================= helpers: time/session ========================= */
function isStale(ts) {
  const ttl = MEMORY_TTL_DAYS * 24 * 60 * 60 * 1000;
  return !ts || Date.now() - ts > ttl;
}

/* ========================= tone pack (Style 1 + 2) ====================== */
const HONORIFICS = ['sir', 'ma’am', 'boss'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function maybeHonorific() { return Math.random() < 0.45 ? ` ${pick(HONORIFICS)}` : ''; }

function askLine(kind) {
  const h = maybeHonorific();
  const bank = {
    payment: [
      `Cash or financing ang plan mo${h}?`,
      `Para ma-ayos ko agad, cash ka ba or financing${h}?`,
      `Noted. Payment mode mo${h} — cash or financing?`,
    ],
    budget: [
      `Magkano target budget mo${h}? (pwede ₱550k, 1.2m, etc.)`,
      `Sige, budget range mo${h}?`,
      `Para di ako lumampas, budget mo${h}?`,
    ],
    location: [
      `Saan ka based${h}? (city/province lang ok)`,
      `Taga saan ka${h}? QC, Pasig, Cavite?`,
      `Para di ako mag-suggest ng malayo, anong area mo${h}?`,
    ],
    transmission: [
      `Automatic or manual${h}? (pwede 'any')`,
      `Trans preference${h} — AT, MT or any?`,
      `Gusto mo automatic, manual, or ok lang kahit alin${h}?`,
    ],
    bodyType: [
      `Body type${h}? sedan, SUV, MPV, van, pickup, hatchback, crossover (or ‘any’).`,
      `Hanap mo${h} anong body type — sedan/SUV/MPV/van/pickup/hatch/crossover?`,
      `May body type ka ba na prefer${h}, or ok lang any?`,
    ]
  };
  return pick(bank[kind] || ['']);
}

function needPhase1(qual) {
  return !(qual?.payment && qual?.budget && qual?.location && qual?.transmission && qual?.bodyType);
}

function nextMissingKey(qual) {
  if (!qual.payment) return 'payment';
  if (!qual.budget) return 'budget';
  if (!qual.location) return 'location';
  if (!qual.transmission) return 'transmission';
  if (!qual.bodyType) return 'bodyType';
  return null;
}

function askNextMissing(session) {
  const key = nextMissingKey(session.qualifier || {});
  if (!key) return null;
  if (!session._asked) session._asked = {};

  // pick a line and avoid repeating the exact same phrase consecutively
  let line = askLine(key);
  const last = session._asked[key];
  if (last === line) line = askLine(key);
  session._asked[key] = line;
  return line;
}

/* ========================= welcome / re-entry =========================== */
function welcomeBlock(session) {
  const firstTime = !session.createdAtTs || isStale(session.createdAtTs);
  if (firstTime) {
    return [{
      type: 'text',
      text: "Hi! 👋 I’m your BentaCars consultant. Tutulungan kitang humanap ng swak na unit—di mo na kailangang mag-scroll nang mag-scroll. Let’s do this. 🙌",
    }];
  }
  return [{
    type: 'buttons',
    text: "Welcome back! 😊 Itutuloy natin kung saan tayo huli, or start over?",
    buttons: [
      { title: 'Continue', payload: 'CONTINUE' },
      { title: 'Start over', payload: 'start over' },
    ],
  }];
}

/* ============================== MAIN ROUTE ============================== */
export async function route(session, userText, rawEvent) {
  const messages = [];
  const now = Date.now();

  // bootstrap session
  session.createdAtTs = session.createdAtTs || now;
  session.phase = session.phase || 'phase1';
  session.qualifier = session.qualifier || {};
  session.funnel = session.funnel || {};

  const payload = (rawEvent?.postback?.payload && String(rawEvent.postback.payload)) || '';

  // quick controls
  if (/^start over$/i.test(payload)) {
    session.phase = 'phase1';
    session.qualifier = {};
    session.funnel = {};
    session._welcomed = false;
    session._asked = {};
  }
  if (/^continue$/i.test(payload)) {
    // keep current phase; no changes
  }

  /* --------------------------- Phase 1 --------------------------------- */
  if (session.phase === 'phase1') {
    if (!session._welcomed) {
      messages.push(...welcomeBlock(session));
      session._welcomed = true;
    }

    // absorb any free text into qualifiers (Taglish, slang, model prefs)
    if (userText) {
      session.qualifier = Qualifier.absorb(session.qualifier, userText);
    }

    // ask only the next missing field, with human tone
    if (needPhase1(session.qualifier)) {
      const ask = askNextMissing(session);
      if (ask) messages.push({ type: 'text', text: ask });
      return { session, messages };
    }

    // all qualifiers complete → natural preface before Phase 2
    const sum = Qualifier.summary(session.qualifier);
    messages.push({
      type: 'text',
      text:
        `Alright, ito’ng hahanapin ko for you:\n` +
        `• ${sum.replace(/ • /g, '\n• ')}\n` +
        `Saglit, I’ll pull the best units that fit this. 🔎`,
    });

    // hand over to Phase 2
    session.phase = 'phase2';
  }

  /* --------------------------- Phase 2 --------------------------------- */
  if (session.phase === 'phase2') {
    const step = await Offers.step(session, userText, rawEvent);
    messages.push(...step.messages);
    session = step.session;

    // move to Phase 3 when user chooses or decides payment path
    if (session.nextPhase === 'cash') {
      session.phase = 'cash';
    } else if (session.nextPhase === 'financing') {
      session.phase = 'financing';
    } else {
      // still browsing offers
      return { session, messages };
    }
  }

  /* ------------------------ Phase 3A: Cash ----------------------------- */
  if (session.phase === 'cash') {
    const step = await CashFlow.step(session, userText, rawEvent);
    messages.push(...step.messages);
    session = step.session;
    return { session, messages };
  }

  /* --------------------- Phase 3B: Financing --------------------------- */
  if (session.phase === 'financing') {
    const step = await FinancingFlow.step(session, userText, rawEvent);
    messages.push(...step.messages);
    session = step.session;
    return { session, messages };
  }

  /* ----------------------------- Fallback ------------------------------ */
  messages.push({
    type: 'text',
    text: 'Sige, tuloy lang tayo. Cash or financing ang plan mo para ma-match ko properly?',
  });
  session.phase = 'phase1';
  return { session, messages };
}

/* -------- Optional shim: keep compatibility if code expects handleMessage --- */
export async function handleMessage({ psid, text, raw }) {
  if (!globalThis.__SESS) globalThis.__SESS = new Map();
  const sess = globalThis.__SESS.get(psid) ?? { psid };
  const { session: newSession, messages } = await route(sess, text, raw);
  globalThis.__SESS.set(psid, newSession);
  return { messages };
}

export default { route, handleMessage };
