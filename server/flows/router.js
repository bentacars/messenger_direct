// /server/flows/router.js
// Phase 1 (conversational qualifiers) → Phase 2 (offers) → Phase 3 (cash/financing)

import * as Qualifier from './qualifier.js';
import * as Offers from './offers.js';
import * as CashFlow from './cash.js';
import * as FinancingFlow from './financing.js';
import { getUserProfile } from '../lib/messenger.js';

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
function maybeHonor(session) {
  // If we know the user's name, DON'T use honorifics
  const hasName = !!(session?.user?.firstName);
  if (hasName) return '';
  return Math.random() < 0.35 ? ` ${pick(HONORIFICS)}` : '';
}
function ack() { return pick(ACKS); }
function firstName(session) { return session?.user?.firstName || ''; }

function askLine(kind, session) {
  const h = maybeHonor(session);
  const name = firstName(session);
  const namePrefix = name ? `${name}, ` : ''; // e.g., "Kamille, "
  const bank = {
    payment: [
      `${namePrefix}pwede tayo sa used cars either cash or hulugan${h}. Ano mas prefer mo?`,
      `${namePrefix}cash or hulugan${h} tayo? Pareho ok—alin ang gusto mo?`,
      `${namePrefix}pwede cash or financing${h}. Ano ang mas swak sa'yo?`,
    ],
    budget: [
      `${namePrefix}${ack()}—magkano target budget mo${h}? (puwede ₱550k, 1.2m, etc.)`,
      `${namePrefix}para di ako lumampas, ano budget mo${h}?`,
      `${namePrefix}sige${h}, budget range mo ilan?`,
    ],
    location: [
      `${namePrefix}nationwide inventory tayo. Saan location mo${h} para ma-match ko sa pinakamalapit na showroom?`,
      `${namePrefix}nationwide kami—anong city/province mo${h} para malapit ang options?`,
      `${namePrefix}saan ka based${h}? (city/province lang) Iha-hanap ko yung pinakamalapit na units.`,
    ],
    transmission: [
      `${namePrefix}marunong ka ba mag-manual${h} or automatic lang—or kahit ano ok?`,
      `${namePrefix}transmission mo${h}—AT, MT, or ok lang kahit alin?`,
      `${namePrefix}gusto mo automatic, manual, or any${h}?`,
    ],
    bodyType: [
      `${namePrefix}5-seater or 7+ seater ba hanap mo${h}? Or van/pickup ok din?`,
      `${namePrefix}body type mo${h}—5-seater, 7-seater/MPV/SUV, or van/pickup?`,
      `${namePrefix}may prefer ka ba—sedan, SUV/MPV (7+), van, pickup—or ok lang any${h}?`,
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
  let line = askLine(key, session);
  if (session._asked[key] === line) line = askLine(key, session); // avoid immediate repeat
  session._asked[key] = line;
  return line;
}

/* ========================= welcome / re-entry =========================== */
function welcomeBlock(session) {
  const firstTime = !session.createdAtTs || isStale(session.createdAtTs);
  const name = firstName(session);
  const hi = name ? `Hi, ${name}!` : 'Hi!';
  if (firstTime) {
    return [{
      type: 'text',
      text: `${hi} 👋 I’m your BentaCars consultant. Tutulungan kitang humanap ng swak na unit—di mo na kailangang mag-scroll nang mag-scroll. Let’s do this. 🙌`,
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

  // bootstrap
  session.createdAtTs = session.createdAtTs || now;
  session.phase = session.phase || 'phase1';
  session.qualifier = session.qualifier || {};
  session.funnel = session.funnel || {};
  session._asked = session._asked || {};

  // Try to fetch user name once per session (non-blocking)
  try {
    const psid = rawEvent?.sender?.id;
    if (psid && !session.user?.firstName && !session._profileTried) {
      session._profileTried = true;
      const prof = await getUserProfile(psid);
      if (prof?.first_name) {
        session.user = { firstName: prof.first_name, lastName: prof.last_name || '', pic: prof.profile_pic || '' };
      }
    }
  } catch (_) { /* ignore profile failures */ }

  const payload = (rawEvent?.postback?.payload && String(rawEvent.postback.payload)) || '';

  /* --------------------------- Quick controls --------------------------- */
  if (/^start over$/i.test(payload)) {
    // hard reset but SKIP welcome UI this turn
    session.phase = 'phase1';
    session.qualifier = {};
    session.funnel = {};
    session._asked = {};
    session._awaitingResume = false;
    session._welcomed = true;           // so we don't show welcome again right now
    session.createdAtTs = Date.now();   // treat like fresh convo
  }

  /* --------------------------- Phase 1 --------------------------------- */
  if (session.phase === 'phase1') {
    // Welcome; for returning users, wait for choice (no qualifiers yet)
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

    // absorb Taglish inputs
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
    const name = firstName(session);
    const lead = name ? `Alright ${name},` : 'Alright,';
    messages.push({
      type: 'text',
      text:
        `${lead} ito’ng hahanapin ko for you:\n` +
        `• ${sum.replace(/ • /g, '\n• ')}\n` +
        `Saglit, I’ll pull the best units that fit this. 🔎`,
    });

    session.phase = 'phase2';
  }

  /* --------------------------- Phase 2 --------------------------------- */
  if (session.phase === 'phase2') {
    const step = await Offers.step(session, userText, rawEvent);
    messages.push(...step.messages);
    session = step.session;

    if (session.nextPhase === 'cash') {
      session.phase = 'cash';
    } else if (session.nextPhase === 'financing') {
      session.phase = 'financing';
    } else {
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

/* -------- Back-compat shim (optional) ---------------------------------- */
export async function handleMessage({ psid, text, raw }) {
  if (!globalThis.__SESS) globalThis.__SESS = new Map();
  const sess = globalThis.__SESS.get(psid) ?? { psid };
  const { session: newSession, messages } = await route(sess, text, raw);
  globalThis.__SESS.set(psid, newSession);
  return { messages };
}

export default { route, handleMessage };
