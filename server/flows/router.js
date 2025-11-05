// /server/flows/router.js
import * as Qualifier from './qualifier.js';
import * as Offers from './offers.js';
import * as CashFlow from './cash.js';
import * as FinancingFlow from './financing.js';
import { getUserProfile } from '../lib/messenger.js';
import { extractSlotsLLM, nlgAskForSlot } from '../lib/ai.js';

const MEMORY_TTL_DAYS = Number(process.env.MEMORY_TTL_DAYS || 7);
const ASK_COOLDOWN_MS = 6000;
const ENABLE_TONE_LLM = String(process.env.ENABLE_TONE_LLM || 'true').toLowerCase() === 'true';

function isStale(ts){ const ttl = MEMORY_TTL_DAYS*24*60*60*1000; return !ts || Date.now()-ts>ttl; }
function needPhase1(q){ return !(q?.payment && q?.budget && q?.location && q?.transmission && q?.bodyType); }
function nextMissingKey(q){ if(!q.payment)return'payment'; if(!q.budget)return'budget'; if(!q.location)return'location'; if(!q.transmission)return'transmission'; if(!q.bodyType)return'bodyType'; return null; }

function welcomeBlock(session){
  const firstTime = !session.createdAtTs || isStale(session.createdAtTs);
  const name = session?.user?.firstName;
  const hi = name ? `Hi, ${name}!` : 'Hi!';
  if (firstTime) {
    return [{ type:'text', text: `${hi} 👋 I’m your BentaCars consultant. Tutulungan kitang humanap ng swak na unit—hindi mo na kailangang mag-scroll.` }];
  }
  return [{ type:'buttons', text:'Welcome back! 😊 Itutuloy natin kung saan tayo huli, or start over?', buttons:[{title:'Continue',payload:'CONTINUE'},{title:'Start over',payload:'start over'}]}];
}

export async function route(session, userText, rawEvent){
  const messages = [];
  const payload = (rawEvent?.postback?.payload && String(rawEvent.postback.payload)) || '';

  // bootstrap
  session.createdAtTs = session.createdAtTs || Date.now();
  session.phase = session.phase || 'phase1';
  session.qualifier = session.qualifier || {};
  session.funnel = session.funnel || {};
  session._asked = session._asked || {};

  // get first name once
  try {
    const psid = rawEvent?.sender?.id;
    if (psid && !session.user?.firstName && !session._profileTried) {
      session._profileTried = true;
      const p = await getUserProfile(psid);
      if (p?.first_name) session.user = { firstName: p.first_name, lastName: p.last_name || '', pic: p.profile_pic || '' };
    }
  } catch {}

  // start over → hard reset but don't double-welcome
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

  /* ---------------- Phase 1 ---------------- */
  if (session.phase === 'phase1') {
    if (!session._welcomed) {
      messages.push(...welcomeBlock(session));
      session._welcomed = true;
      const firstTime = !session.createdAtTs || isStale(session.createdAtTs);
      if (!firstTime) { session._awaitingResume = true; return { session, messages }; }
    }

    if (session._awaitingResume) {
      if (payload === 'CONTINUE' || /^start over$/i.test(payload)) session._awaitingResume = false;
      else return { session, messages };
    }

    // Extract with LLM + merge with our regex-based absorb()
    if (userText) {
      const llm = ENABLE_TONE_LLM ? await extractSlotsLLM(userText) : null;
      const merged = { ...session.qualifier };
      if (llm) for (const k of ['payment','budget','location','transmission','bodyType','brand','model','variant','year']) {
        if (llm[k] != null && llm[k] !== '') merged[k] = llm[k];
      }
      session.qualifier = Qualifier.absorb(merged, userText);
    }

    if (needPhase1(session.qualifier)) {
      const key = nextMissingKey(session.qualifier);
      const now = Date.now();
      if (session._lastAskedKey === key && (now - (session._lastAskedAt||0)) < ASK_COOLDOWN_MS) {
        return { session, messages }; // anti-spam
      }

      let line;
      if (ENABLE_TONE_LLM) {
        const avoid = session._asked[key] || '';
        line = await nlgAskForSlot(key, session.qualifier, session?.user?.firstName, avoid);
      } else {
        // fallback static phrasing
        const F = {
          payment:'Pwede cash or hulugan. Ano mas prefer mo?',
          budget:'Para hindi ako lumampas, mga magkano budget mo?',
          location:'Nationwide tayo—saan ka based para malapit ang options?',
          transmission:'Automatic, manual, or ok lang kahit alin?',
          bodyType:'5-seater or 7+ seater? Or van/pickup ok din?'
        };
        line = F[key];
      }

      messages.push({ type:'text', text: line });
      session._asked[key] = line;
      session._lastAskedKey = key;
      session._lastAskedAt = now;
      return { session, messages };
    }

    // done collecting → summary then proceed
    const sum = Qualifier.summary(session.qualifier);
    const lead = session?.user?.firstName ? `Alright ${session.user.firstName},` : 'Alright,';
    messages.push({ type:'text', text: `${lead} ito’ng hahanapin ko for you:\n• ${sum.replace(/ • /g, '\n• ')}\nSaglit, I’ll pull the best units that fit this. 🔎` });
    session.phase = 'phase2';
  }

  /* ---------------- Phase 2 / 3 ---------------- */
  if (session.phase === 'phase2') {
    const step = await Offers.step(session, userText, rawEvent);
    messages.push(...step.messages);
    session = step.session;
    if (session.nextPhase === 'cash') session.phase = 'cash';
    else if (session.nextPhase === 'financing') session.phase = 'financing';
    else return { session, messages };
  }

  if (session.phase === 'cash') {
    const step = await CashFlow.step(session, userText, rawEvent);
    messages.push(...step.messages);
    session = step.session;
    return { session, messages };
  }

  if (session.phase === 'financing') {
    const step = await FinancingFlow.step(session, userText, rawEvent);
    messages.push(...step.messages);
    session = step.session;
    return { session, messages };
  }

  messages.push({ type:'text', text:'Sige, tuloy lang tayo. Cash or financing ang plan mo para ma-match ko properly?' });
  session.phase = 'phase1';
  return { session, messages };
}

export async function handleMessage({ psid, text, raw }) {
  if (!globalThis.__SESS) globalThis.__SESS = new Map();
  const sess = globalThis.__SESS.get(psid) ?? { psid };
  const { session: s, messages } = await route(sess, text, raw);
  globalThis.__SESS.set(psid, s);
  return { messages };
}

export default { route, handleMessage };
