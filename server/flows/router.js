// /server/flows/router.js
// Phase 1 (conversational qualifiers) → Phase 2 (offers) → Phase 3 (cash/financing)

import * as Qualifier from './qualifier.js';
import * as Offers from './offers.js';
import * as CashFlow from './cash.js';
import * as FinancingFlow from './financing.js';
import { getUserProfile } from '../lib/messenger.js';

const MEMORY_TTL_DAYS = Number(process.env.MEMORY_TTL_DAYS || 7);

/* ========================= helpers: time/session ========================= */
function isStale(ts) { const ttl = MEMORY_TTL_DAYS * 24 * 60 * 60 * 1000; return !ts || Date.now() - ts > ttl; }

/* ========================= Tone pack (Style 1 + 2) ====================== */
const HONORIFICS = ['sir', 'ma’am', 'boss'];
const ACKS = ['Got it', 'Copy', 'Sige', 'Noted', 'Game', 'Solid'];
const ASK_COOLDOWN_MS = 8000; // avoid re-asking same key too fast

function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function firstName(session){ return session?.user?.firstName || ''; }
function maybeHonor(session){ return session?.user?.firstName ? '' : (Math.random()<0.35 ? ` ${pick(HONORIFICS)}` : ''); }
function ack(){ return pick(ACKS); }

/* ---------- Quick intent mapping (pre-absorb) ---------- */
function quickMapIntoQual(session, userText){
  if (!userText) return false;
  const t = String(userText).toLowerCase();
  let changed = false;

  // payment
  const wantFin = /\bhulug(an)?\b|\binstallment\b|\bfinanc(ing|e)\b|\bloan\b|\butang\b/.test(t);
  const wantCash = /\bcash\b|\bspot\s*cash\b|\bstraight\b/.test(t);
  if (!session.qualifier.payment && (wantFin || wantCash)) {
    session.qualifier.payment = wantFin ? 'financing' : 'cash';
    changed = true;
  }

  // transmission any/at/mt
  if (!session.qualifier.transmission) {
    if (/\b(at|auto|automatic)\b/.test(t)) { session.qualifier.transmission = 'automatic'; changed = true; }
    else if (/\b(mt|manual)\b/.test(t))   { session.qualifier.transmission = 'manual'; changed = true; }
    else if (/\b(any|kahit\s*ano)\b/.test(t)) { session.qualifier.transmission = 'any'; changed = true; }
  }

  // body type hints
  if (!session.qualifier.bodyType) {
    if (/\bsedan\b/.test(t)) session.qualifier.bodyType = 'sedan', changed = true;
    else if (/\b(suv|crossover)\b/.test(t)) session.qualifier.bodyType = 'suv', changed = true;
    else if (/\bmpv|7\+|7\s*seater|seven/.test(t)) session.qualifier.bodyType = 'mpv', changed = true;
    else if (/\bvan\b/.test(t)) session.qualifier.bodyType = 'van', changed = true;
    else if (/\bpick[\s-]?up\b/.test(t)) session.qualifier.bodyType = 'pickup', changed = true;
    else if (/\bany\b/.test(t)) session.qualifier.bodyType = 'any', changed = true;
  }

  return changed;
}

/* -------------------- conversational lines -------------------- */
function askLine(kind, session){
  const h = maybeHonor(session);
  const name = firstName(session);
  const you = name ? `${name}, ` : '';
  const bank = {
    payment: [
      `${you}pwede tayo sa used cars either cash or hulugan${h}. Ano mas prefer mo?`,
      `${you}cash or hulugan${h} tayo? Pareho ok—alin ang gusto mo?`,
      `${you}pwede cash or financing${h}. Ano ang mas swak sa'yo?`,
    ],
    budget: [
      `${you}${ack()}—magkano target budget mo${h}? (puwede ₱550k, 1.2m, etc.)`,
      `${you}para di ako lumampas, ano budget mo${h}?`,
      `${you}sige${h}, budget range mo ilan?`,
    ],
    location: [
      `${you}nationwide inventory tayo. Saan location mo${h} para ma-match ko sa pinakamalapit na showroom?`,
      `${you}nationwide kami—anong city/province mo${h} para malapit ang options?`,
      `${you}saan ka based${h}? (city/province lang) Iha-hanap ko yung pinakamalapit na units.`,
    ],
    transmission: [
      `${you}marunong ka ba mag-manual${h} or automatic lang—or kahit ano ok?`,
      `${you}transmission mo${h}—AT, MT, or ok lang kahit alin?`,
      `${you}gusto mo automatic, manual, or any${h}?`,
    ],
    bodyType: [
      `${you}5-seater or 7+ seater ba hanap mo${h}? Or van/pickup ok din?`,
      `${you}body type mo${h}—sedan, 7-seater/MPV/SUV, or van/pickup?`,
      `${you}may prefer ka ba—sedan, SUV/MPV (7+), van, pickup—or ok lang any${h}?`,
    ],
  };
  return pick(bank[kind] || ['']);
}

function needPhase1(q){ return !(q?.payment && q?.budget && q?.location && q?.transmission && q?.bodyType); }
function nextMissingKey(q){ if (!q.payment) return 'payment'; if (!q.budget) return 'budget'; if (!q.location) return 'location'; if (!q.transmission) return 'transmission'; if (!q.bodyType) return 'bodyType'; return null; }

function askNextMissing(session){
  const key = nextMissingKey(session.qualifier || {});
  if (!key) return null;
  const now = Date.now();

  // Anti-repeat: if we asked this key very recently and nothing changed, skip asking it again
  if (session._lastAskedKey === key && session._lastAskedAt && now - session._lastAskedAt < ASK_COOLDOWN_MS) {
    return null;
  }

  let line = askLine(key, session);
  if (!session._asked) session._asked = {};
  if (session._asked[key] === line) line = askLine(key, session);
  session._asked[key] = line;

  session._lastAskedKey = key;
  session._lastAskedAt = now;
  return line;
}

/* -------------------- welcome / re-entry -------------------- */
function welcomeBlock(session){
  const firstTime = !session.createdAtTs || isStale(session.createdAtTs);
  const name = firstName(session);
  const hi = name ? `Hi, ${name}!` : 'Hi!';
  if (firstTime) {
    return [{ type: 'text', text: `${hi} 👋 I’m your BentaCars consultant. Tutulungan kitang humanap ng swak na unit—di mo na kailangang mag-scroll nang mag-scroll. Let’s do this. 🙌` }];
  }
  return [{
    type: 'buttons',
    text: "Welcome back! 😊 Itutuloy natin kung saan tayo huli, or start over?",
    buttons: [{ title: 'Continue', payload: 'CONTINUE' }, { title: 'Start over', payload: 'start over' }],
  }];
}

/* ============================== MAIN ROUTE ============================== */
export async function route(session, userText, rawEvent){
  const messages = [];
  const now = Date.now();

  // bootstrap
  session.createdAtTs = session.createdAtTs || now;
  session.phase = session.phase || 'phase1';
  session.qualifier = session.qualifier || {};
  session.funnel = session.funnel || {};
  session._asked = session._asked || {};

  // fetch name once (non-blocking)
  try {
    const psid = rawEvent?.sender?.id;
    if (psid && !session.user?.firstName && !session._profileTried) {
      session._profileTried = true;
      const prof = await getUserProfile(psid);
      if (prof?.first_name) session.user = { firstName: prof.first_name, lastName: prof.last_name || '', pic: prof.profile_pic || '' };
    }
  } catch {}

  const payload = (rawEvent?.postback?.payload && String(rawEvent.postback.payload)) || '';

  /* ----------- Quick controls ----------- */
  if (/^start over$/i.test(payload)) {
    session.phase = 'phase1';
    session.qualifier = {};
    session.funnel = {};
    session._asked = {};
    session._awaitingResume = false;
    session._welcomed = true;          // skip welcome loop this turn
    session._lastAskedKey = null;
    session._lastAskedAt = 0;
    session.createdAtTs = Date.now();
  }

  /* --------------------------- Phase 1 --------------------------------- */
  if (session.phase === 'phase1') {
    if (!session._welcomed) {
      messages.push(...welcomeBlock(session));
      session._welcomed = true;
      const firstTime = !session.createdAtTs || isStale(session.createdAtTs);
      if (!firstTime) { session._awaitingResume = true; return { session, messages }; }
    }

    if (session._awaitingResume) {
      if (payload === 'CONTINUE') session._awaitingResume = false;
      else if (/^start over$/i.test(payload)) session._awaitingResume = false;
      else return { session, messages };
    }

    // 1) Fast map (recognize hulugan/cash etc) BEFORE absorb
    const changedByQuick = quickMapIntoQual(session, userText);

    // 2) Normal absorb (multi-value extraction)
    if (userText) {
      const before = JSON.stringify(session.qualifier);
      session.qualifier = Qualifier.absorb(session.qualifier, userText);
      const after = JSON.stringify(session.qualifier);

      // If something changed, clear lastAskedKey so we can move forward
      if (changedByQuick || before !== after) {
        session._lastAskedKey = null;
        session._lastAskedAt = 0;
      }
    }

    if (needPhase1(session.qualifier)) {
      const ask = askNextMissing(session);
      if (ask) { messages.push({ type: 'text', text: ask }); return { session, messages }; }
      // If ask is null (due to cooldown), move on to next missing key instead of spamming same question
      // Force-advance by clearing cooldown after a short pause on next turn
      return { session, messages };
    }

    const sum = Qualifier.summary(session.qualifier);
    const lead = firstName(session) ? `Alright ${firstName(session)},` : 'Alright,';
    messages.push({ type: 'text', text: `${lead} ito’ng hahanapin ko for you:\n• ${sum.replace(/ • /g, '\n• ')}\nSaglit, I’ll pull the best units that fit this. 🔎` });

    session.phase = 'phase2';
  }

  /* --------------------------- Phase 2 --------------------------------- */
  if (session.phase === 'phase2') {
    const step = await Offers.step(session, userText, rawEvent);
    messages.push(...step.messages);
    session = step.session;

    if (session.nextPhase === 'cash') session.phase = 'cash';
    else if (session.nextPhase === 'financing') session.phase = 'financing';
    else return { session, messages };
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
  messages.push({ type: 'text', text: 'Sige, tuloy lang tayo. Cash or financing ang plan mo para ma-match ko properly?' });
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
