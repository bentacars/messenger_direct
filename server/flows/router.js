// /server/flows/router.js
// Phase 1 (LLM-powered conversational qualifiers) → Phase 2 (offers) → Phase 3 (cash/financing)

import * as Qualifier from './qualifier.js';
import * as Offers from './offers.js';
import * as CashFlow from './cash.js';
import * as FinancingFlow from './financing.js';
import { getUserProfile } from '../lib/messenger.js';
import { extractSlotsLLM, nlgAskForSlot } from '../lib/ai.js';

const MEMORY_TTL_DAYS = Number(process.env.MEMORY_TTL_DAYS || 7);
const ASK_COOLDOWN_MS = 6000;

/* -------------------- helpers -------------------- */
function isStale(ts) { const ttl = MEMORY_TTL_DAYS * 24*60*60*1000; return !ts || Date.now()-ts > ttl; }
function needPhase1(q){ return !(q?.payment && q?.budget && q?.location && q?.transmission && q?.bodyType); }
function nextMissingKey(q){ if (!q.payment) return 'payment'; if (!q.budget) return 'budget'; if (!q.location) return 'location'; if (!q.transmission) return 'transmission'; if (!q.bodyType) return 'bodyType'; return null; }

function welcomeBlock(session){
  const firstTime = !session.createdAtTs || isStale(session.createdAtTs);
  const name = session?.user?.firstName;
  const hi = name ? `Hi, ${name}!` : 'Hi!';
  if (firstTime) {
    return [{ type:'text', text: `${hi} 👋 I’m your BentaCars consultant. Tutulungan kitang humanap ng swak na unit—hindi mo na kailangang mag-scroll. Let’s do this. 🙌` }];
  }
  return [{
    type:'buttons',
    text: 'Welcome back! 😊 Itutuloy natin kung saan tayo huli, or start over?',
    buttons: [{ title:'Continue', payload:'CONTINUE' }, { title:'Start over', payload:'start over' }]
  }];
}

/* -------------------- main route -------------------- */
export async function route(session, userText, rawEvent){
  const messages = [];
  const now = Date.now();

  // bootstrap
  session.createdAtTs = session.createdAtTs || now;
  session.phase = session.phase || 'phase1';
  session.qualifier = session.qualifier || {};
  session.funnel = session.funnel || {};
  session._asked = session._asked || {};

  const payload = (rawEvent?.postback?.payload && String(rawEvent.postback.payload)) || '';

  // name lookup once
  try {
    const psid = rawEvent?.sender?.id;
    if (psid && !session.user?.firstName && !session._profileTried) {
      session._profileTried = true;
      const p = await getUserProfile(psid);
      if (p?.first_name) session.user = { firstName: p.first_name, lastName: p.last_name || '', pic: p.profile_pic || '' };
    }
  } catch {}

  // start over → reset but skip welcome loop this turn
  if (/^start over$/i.test(payload)) {
    session.phase = 'phase1';
    session.qualifier = {};
    session.funnel = {};
    session._asked = {};
    session._awaitingResume = false;
    session._welcomed = true;
    session._lastAskedKey = null;
    session._lastAskedAt = 0;
    session.createdAtTs = Date.now();
  }

  /* -------------------- Phase 1 -------------------- */
  if (session.phase === 'phase1') {
    if (!session._welcomed) {
      messages.push(...welcomeBlock(session));
      session._welcomed = true;
      const firstTime = !session.createdAtTs || isStale(session.createdAtTs);
      if (!firstTime) { session._awaitingResume = true; return { session, messages }; }
    }

    if (session._awaitingResume) {
      if (payload === 'CONTINUE' || /^start over$/i.test(payload)) {
        session._awaitingResume = false;
      } else {
        return { session, messages };
      }
    }

    // 1) LLM extraction (strict JSON), then merge to your Qualifier logic
    if (userText) {
      const llm = await extractSlotsLLM(userText);
      const merged = { ...session.qualifier };
      // prefer LLM values when present
      if (llm) {
        for (const k of ['payment','budget','location','transmission','bodyType','brand','model','variant','year']) {
          if (llm[k] != null && llm[k] !== '') merged[k] = llm[k];
        }
      }
      // retain your custom absorb (regex rules, etc.)
      session.qualifier = Qualifier.absorb(merged, userText);
    }

    // 2) Ask only the next missing slot, with AI-generated phrasing
    if (needPhase1(session.qualifier)) {
      const key = nextMissingKey(session.qualifier);
      const now = Date.now();

      // anti-repeat: if we just asked the same key and nothing changed, don't spam
      if (session._lastAskedKey === key && (now - (session._lastAskedAt || 0)) < ASK_COOLDOWN_MS) {
        return { session, messages };
      }

      const avoid = session._asked[key] || ''; // avoid same wording
      const q = await nlgAskForSlot(key, session.qualifier, session?.user?.firstName, avoid);
      if (q) {
        messages.push({ type:'text', text: q });
        session._asked[key] = q;
        session._lastAskedKey = key;
        session._lastAskedAt = now;
      }
      return { session, messages };
    }

    // 3) Done with slots → natural summary
    const sum = Qualifier.summary(session.qualifier);
    const lead = session?.user?.firstName ? `Alright ${session.user.firstName},` : 'Alright,';
    messages.push({ type:'text', text: `${lead} ito’ng hahanapin ko for you:\n• ${sum.replace(/ • /g, '\n• ')}\nSaglit, I’ll pull the best units that fit this. 🔎` });

    session.phase = 'phase2';
  }

  /* -------------------- Phase 2 -------------------- */
  if (session.phase === 'phase2') {
    const step = await Offers.step(session, userText, rawEvent);
    messages.push(...step.messages);
    session = step.session;

    if (session.nextPhase === 'cash') session.phase = 'cash';
    else if (session.nextPhase === 'financing') session.phase = 'financing';
    else return { session, messages };
  }

  /* -------------------- Phase 3A: Cash -------------------- */
  if (session.phase === 'cash') {
    const step = await CashFlow.step(session, userText, rawEvent);
    messages.push(...step.messages);
    session = step.session;
    return { session, messages };
  }

  /* -------------------- Phase 3B: Financing -------------------- */
  if (session.phase === 'financing') {
    const step = await FinancingFlow.step(session, userText, rawEvent);
    messages.push(...step.messages);
    session = step.session;
    return { session, messages };
  }

  // Fallback
  messages.push({ type:'text', text:'Sige, tuloy lang tayo. Cash or financing ang plan mo para ma-match ko properly?' });
  session.phase = 'phase1';
  return { session, messages };
}

/* Optional back-compat shim */
export async function handleMessage({ psid, text, raw }) {
  if (!globalThis.__SESS) globalThis.__SESS = new Map();
  const sess = globalThis.__SESS.get(psid) ?? { psid };
  const { session: newSession, messages } = await route(sess, text, raw);
  globalThis.__SESS.set(psid, newSession);
  return { messages };
}

export default { route, handleMessage };
