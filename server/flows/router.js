// server/flows/router.js
import { getSession, saveSession, clearSession } from '../lib/session.js';
import { sendQuick, sendText, sendTypingOn, sendTypingOff } from '../lib/messenger.js';
import { PAYLOADS, PH_TZ } from '../constants.js';

import * as Qualifier from './qualifier.js';
import * as Offers from './offers.js';
import * as Cash from './cash.js';
import * as Fin from './financing.js';
import { handleInterrupts, handleSmallTalk } from './interrupts.js';

function wantsStartOver(t='') { return /^(start over|restart|reset)$/i.test(t); }
function wantsContinue(t='') { return /^(continue|resume)$/i.test(t); }
function greetOrStart(t='') { return /^(hi|hello|hey|start|get started)$/i.test(t); }

function normalizeText(evt) {
  const msg = evt.message || {};
  if (msg.quick_reply?.payload) return String(msg.quick_reply.payload);
  if (typeof msg.text === 'string') return msg.text;
  if (evt.postback?.payload) return String(evt.postback.payload);
  if (evt.postback?.title) return String(evt.postback.title);
  return '';
}

export async function handleMessage({ psid, userText, rawEvent }) {
  const text = (userText || normalizeText(rawEvent) || '').trim();

  // load session
  let session = (await getSession(psid)) || {};
  session.lastInteractionAt = Date.now();
  await saveSession(psid, session);

  // Start Over / Continue
  if (wantsStartOver(text)) {
    await clearSession(psid);
    session = { psid, qualifiers:{} };
    await saveSession(psid, session);
    return Qualifier.start({ psid, session });
  }
  if (wantsContinue(text) && session.funnel?.agent) {
    // resume current agent
  } else if (greetOrStart(text) && session.funnel?.agent) {
    // show resume card
    return sendQuick(psid, 'Welcome back! 😊 Itutuloy natin kung saan tayo huli, or start over?', [
      { title:'Continue', payload: PAYLOADS.CONTINUE },
      { title:'Start over', payload: PAYLOADS.START_OVER },
    ]);
  }

  // Interrupt layer (FAQ/objections)
  const pendingResume =
    session.funnel?.agent === 'qualifier' ? 'Para ma-match kita, sagutin natin muna yung kulang.' :
    session.funnel?.agent === 'offers'    ? 'Sige, tuloy ko ipapakita yung mga units na pasok.' :
    session.phase === 'cash'              ? 'Tuloy natin ang viewing schedule / contact details.' :
    session.phase === 'financing'         ? 'Tuloy natin ang financing estimate at docs.' :
    'Tuloy natin.';

  const intRes = await handleInterrupts(psid, text, pendingResume);
  if (intRes.handled) return;

  // If message is clearly small talk and not a field answer:
  if (!text && rawEvent?.message?.attachments?.length) {
    // attachments handled below (docs)
  } else if (!session.funnel?.agent && !greetOrStart(text)) {
    // small talk before start → short then start
    await handleSmallTalk(psid, text, 'Game, start tayo para mahanap ko best unit.');
    return Qualifier.start({ psid, session:{...session, qualifiers:{}} });
  }

  // Routing by agent/phase
  if (!session.funnel?.agent) {
    return Qualifier.start({ psid, session:{...session, qualifiers:{}} });
  }

  if (session.funnel.agent === 'qualifier') {
    const done = await Qualifier.step({ psid, session, userText: text });
    if (done === true || !pendingNext(session)) {
      session.funnel.agent = 'offers';
      await saveSession(psid, session);
      return Offers.step({ psid, session });
    }
    return; // still collecting
  }

  // Offers navigation
  if (session.funnel.agent === 'offers') {
    if (text.startsWith('CHOOSE:')) {
      const sku = text.split(':')[1];
      const unit = Offers.findUnitBySku(session, sku);
      if (!unit) return sendText(psid, 'Di ko mahanap yung unit na yan — pili ka ulit.');
      await sendText(psid, 'Solid choice! 🔥 Sending full photos…');
      await Cash.photos({ psid, session, unit });

      if ((session.qualifiers||{}).payment === 'cash') {
        session.phase = 'cash';
        session.cash = { ...(session.cash||{}), unit };
        await saveSession(psid, session);
        return Cash.start({ psid, session });
      } else {
        session.phase = 'financing';
        session.cash = { ...(session.cash||{}), unit }; // reuse address later
        await saveSession(psid, session);
        await Cash.start({ psid, session }); // schedule first (same rule)
        return Fin.start({ psid, session });
      }
    }
    if (text === 'SHOW_OTHERS') {
      return Offers.showOthers({ psid, session });
    }
    // otherwise, repeat batch
    return Offers.step({ psid, session, userText: text });
  }

  // Phase 3 Cash
  if (session.phase === 'cash') {
    // attachments as docs? We ignore—cash flow only needs contact
    if (!session.cash?.schedule_locked) {
      return Cash.onSchedule({ psid, session, userText: text });
    }
    // expect name + mobile
    return Cash.onContact({ psid, session, userText: text });
  }

  // Phase 3 Financing
  if (session.phase === 'financing') {
    // doc uploads (image/PDF)
    const atts = rawEvent?.message?.attachments || [];
    if (atts.length) {
      await Fin.onDocReceived({ psid, session });
      return;
    }
    if (!session.cash?.schedule_locked) return Cash.onSchedule({ psid, session, userText: text });
    if (!session.fin?.incomeType) {
      return Fin.onIncomeType({ psid, session, userText: text });
    }
    // estimates
    if (!session.fin?.sentEst) {
      await Fin.sendEstimates({ psid, session, unit: session.cash?.unit });
      session.fin.sentEst = true;
      await saveSession(psid, session);
      return;
    }
    // keep friendly loop
    return Fin.onIncomeType({ psid, session, userText: text });
  }

  // fallback
  return sendText(psid, 'Sige, tuloy natin.');
}

function pendingNext(session) {
  const q = session.qualifiers || {};
  return !(q.payment && (q.budgetCash || q.budgetAllIn) && (q.locationCity || q.locationProvince) && q.trans && q.body);
}
