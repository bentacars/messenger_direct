// server/flows/qualifier.js
import { saveSession } from '../lib/session.js';
import { sendText } from '../lib/messenger.js';
import { extractQualifiersHeuristic, nlg } from '../lib/ai.js';

function missingFields(q) {
  const need = [];
  if (!q.payment) need.push('payment');
  if (q.payment === 'cash' && !q.budgetCash) need.push('budgetCash');
  if (q.payment === 'financing' && !q.budgetAllIn) need.push('budgetAllIn');
  if (!q.locationCity && !q.locationProvince) need.push('location');
  if (!q.trans) need.push('trans');
  if (!q.body) need.push('body');
  return need;
}

function resumePrompt(q) {
  const need = missingFields(q);
  if (!need.length) return '';
  const n = need[0];
  if (n === 'payment') return 'Pwede tayo cash or hulugan — alin ang prefer mo?';
  if (n === 'budgetCash') return 'Magkano target cash budget mo? (e.g., ₱550,000)';
  if (n === 'budgetAllIn') return 'Magkano kaya mong all-in? (e.g., ₱95,000)';
  if (n === 'location') return 'Nationwide tayo — saan ka based (city/province) para ma-match ko sa pinakamalapit?';
  if (n === 'trans') return 'Auto, manual, o okay lang kahit alin?';
  if (n === 'body') return '5-seater (sedan/hatch) o 7+ seater (SUV/MPV)? Pwede ring van/pickup.';
  return '';
}

export async function start({ psid, session }) {
  const welcome = 'Hi! 👋 Ako na bahala mag-match ng best unit para sa’yo—hindi mo na kailangang mag-scroll nang marami. Let’s find your car, fast.';
  await sendText(psid, welcome);
  session.funnel = { agent:'qualifier' };
  session.qualifiers = session.qualifiers || {};
  await saveSession(psid, session);
  const ask = resumePrompt(session.qualifiers);
  if (ask) await sendText(psid, ask);
}

export async function step({ psid, session, userText }) {
  session.qualifiers = session.qualifiers || {};
  const got = extractQualifiersHeuristic(userText || '');
  session.qualifiers = { ...session.qualifiers, ...got };
  await saveSession(psid, session);

  const ask = resumePrompt(session.qualifiers);
  if (ask) {
    // Conversational phrasing via LLM NLG
    const line = await nlg({ user: `Rewrite this as a short Taglish friendly question: "${ask}"` });
    return sendText(psid, line);
  }

  // All set → Phase 2 handoff is in router
  return true;
}
