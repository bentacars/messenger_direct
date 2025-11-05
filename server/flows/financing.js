// server/flows/financing.js
import { saveSession } from '../lib/session.js';
import { sendText } from '../lib/messenger.js';
import { PH_TZ, DOCS_FOLLOW_INTERVAL_HOURS, DOCS_FOLLOW_MAX_HOURS } from '../constants.js';

function phNow() { return new Date(new Date().toLocaleString('en-US', { timeZone: PH_TZ })); }

export async function start({ psid, session }) {
  session.fin = session.fin || {};
  await saveSession(psid, session);
  await sendText(psid, 'While I’m locking your viewing schedule: since financing tayo — ano po source of income ninyo? Employed, business, o OFW/Seaman?');
}

export async function sendEstimates({ psid, session, unit }) {
  const allin = unit.all_in ? `All-in cash-out: ₱${Number(unit.all_in).toLocaleString()}` : '';
  const p2 = unit['2yrs'] ? `2yrs: ₱${Number(unit['2yrs']).toLocaleString()}` : '';
  const p3 = unit['3yrs'] ? `3yrs: ₱${Number(unit['3yrs']).toLocaleString()}` : '';
  const p4 = unit['4yrs'] ? `4yrs: ₱${Number(unit['4yrs']).toLocaleString()}` : '';
  const lines = [allin, p2, p3, p4].filter(Boolean).join(' | ');
  await sendText(psid, `${lines}\nEstimated lang po ito — final depends sa income documents.\nIlang years nyo plan hulugan?`);
}

export async function onIncomeType({ psid, session, userText }) {
  const s = (userText||'').toLowerCase();
  session.fin = session.fin || {};
  if (/employ/.test(s)) session.fin.incomeType = 'employed';
  else if (/business|self/.test(s)) session.fin.incomeType = 'business';
  else if (/ofw|seaman|seafarer/.test(s)) session.fin.incomeType = 'ofw';

  await saveSession(psid, session);

  if (session.fin.incomeType === 'employed') {
    await sendText(psid, 'Employed — may COE na ba kayo or magrerequest pa lang? Pwede nyo isend dito payslip/COE + valid ID anytime para ma-start ang pre-approval.');
  } else if (session.fin.incomeType === 'business') {
    await sendText(psid, 'Business owner — ano nature ng business? May DTI/permit ba? Send DTI/permit + 3-month income proof (bank statement/receipts) + valid ID para ma-pre approve.');
  } else if (session.fin.incomeType === 'ofw') {
    await sendText(psid, 'Kayo ba mismong OFW/Seaman or kayo yung receiver ng remittance? Kung OFW/Seaman: passport/seaman book + contract + remittance + ID. Kung receiver: remittance proof + ID.');
  } else {
    await sendText(psid, 'Copy! You can send any available ID or proof muna para ma-pre screen natin.');
  }

  // Start docs follow-up timer
  session.docsFollowStartAt = session.docsFollowStartAt || phNow().getTime();
  await saveSession(psid, session);
}

// Called when any doc arrives (image/PDF)
export async function onDocReceived({ psid, session }) {
  await sendText(psid, 'Got it! ✅ Our team is now reviewing what you sent. Expect a call from us para mapabilis ang release ng sasakyan mo. 🚗💨');
  // stop follow-ups by clearing start time
  session.docsFollowStartAt = null;
  await saveSession(psid, session);
}
