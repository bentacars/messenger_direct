// /server/flows/router.js
// Central conversation router: Phase 1 (qualifiers, conversational) → Phase 2 (offers) → Phase 3 (cash/financing)

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

/* ========================= Tone pack (Style 1 + 2) ====================== */
const HONORIFICS = ['sir', 'ma’am', 'boss'];
const ACKS = ['Got it', 'Copy', 'Sige', 'Noted', 'Game', 'Solid'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function maybeHonor() { return Math.random() < 0.35 ? ` ${pick(HONORIFICS)}` : ''; }
function ack() { return pick(ACKS); }

function askLine(kind) {
  const h = maybeHonor();
  const bank = {
    payment: [
      `Pwede tayo sa used cars either cash or hulugan${h}. Ano mas prefer mo?`,
      `Cash or hulugan${h} tayo? Pareho ok—alin ang gusto mo?`,
      `Pwede cash or financing${h}. Ano ang mas swak sa'yo?`,
    ],
    budget: [
      `${ack()}—magkano target budget mo${h}? (puwede ₱550k, 1.2m, etc.)`,
      `Para di ako lumampas, ano budget mo${h}?`,
      `Sige${h}, budget range mo ilan?`,
    ],
    location: [
      `Nationwide inventory tayo. Saan location mo${h} para ma-match ko sa pinakamalapit na showroom?`,
      `Nationwide kami—anong city/province mo${h} para malapit ang options?`,
      `Saan ka based${h}? (city/province lang) Iha-hanap ko yung pinakamalapit na units.`,
    ],
    transmission: [
      `Marunong ka ba mag-manual${h} or automatic lang—or kahit ano ok?`,
      `Transmission mo${h}—AT, MT, or ok lang kahit alin?`,
      `Gusto mo automatic, manual, or any${h}?`,
    ],
    bodyType: [
      `5-seater or 7+ seater ba hanap mo${h}? Or van/pickup ok din?`,
      `Body type mo${h}—5-seater, 7-seater/MPV/SUV, or van/pickup?`,
      `May prefer ka ba—sedan, SUV/MPV (7+), van, pickup—or ok lang any${h}?`,
    ],
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
  let line = askLine(key);
  if (session._asked[key] === line) line = askLine(key); // avoid immediate repeat
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
  session._asked = session._asked || {};

  const payload = (rawEvent?.postback?.payload && String(rawEvent.postback.payload)) || '';

  /* --------------------------- Quick controls --------------------------- */
  if (/^start over$/i.test(payload)) {
    // hard reset but SKIP the welcome UI on purpose
    session.phase = 'phase1';
    session.qualifier = {};
    session.funnel = {};
    session._asked = {};
    session._awaitingResume = false;

    // Important: mark welcomed so we don't show the buttons again this turn
    session._welcomed = true;

    // Treat as a fresh conversation (prevents "returning" branch)
    session.createdAtTs = Date.now();
  }

  /* --------------------------- Phase 1 --------------------------------- */
  if (session.phase === 'phase1') {
    // Show welcome; for returning users, wait for choice (no qualifiers yet)
    if (!session._welcomed) {
      const blocks = welcomeBlock(session);
      messages.push(...blocks);
      session._welcomed = true;

      const firstTime = !session.createdAtTs || isStale(session.createdAtTs);
      if (!firstTime) {
        session._awaitingResume = true;
        return { session, messages }; // wait for Continue/Start over
      }
    }

    // If returning and still waiting for a button tap, do nothing else
    if (session._awaitingResume) {
      if (payload === 'CONTINUE') {
        session._awaitingResume = false; // proceed
      } else if (/^start over$/i.test(payload)) {
        session._awaitingResume = false; // reset handled above
      } else {
        return { session, messages };
      }
    }

    // absorb Taglish inputs; extracts multiple values in one message
    if (userText) {
      session.qualifier = Qualifier.absorb(session.qualifier, userText);
    }

    // ask only the next missing field
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

/* -------- Optional shim: compatibility if code expects handleMessage ----- */
export async function handleMessage({ psid, text, raw }) {
  if (!globalThis.__SESS) globalThis.__SESS = new Map();
  const sess = globalThis.__SESS.get(psid) ?? { psid };
  const { session: newSession, messages } = await route(sess, text, raw);
  globalThis.__SESS.set(psid, newSession);
  return { messages };
}

export default { route, handleMessage };
