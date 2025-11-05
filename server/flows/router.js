// server/flows/router.js
import { sendText, sendTypingOn, sendTypingOff } from '../lib/messenger.js';
import Qualifier from './qualifier.js';
import Offers from './offers.js';
import { SESSION_TTL_MS } from '../constants.js';

const sessions = new Map(); // psid -> { qualifier, history, ... , ts }

function getSession(psid) {
  const now = Date.now();
  let s = sessions.get(psid);
  if (!s || (now - (s.ts || 0)) > SESSION_TTL_MS) {
    s = { psid, qualifier: {}, history: [], ts: now };
    sessions.set(psid, s);
  } else {
    s.ts = now;
  }
  return s;
}

function isPostback(raw, payloadStarts) {
  const p = raw?.postback?.payload || '';
  return payloadStarts.some(x => p.startsWith(x));
}

export async function handleMessage({ psid, text, raw }) {
  const session = getSession(psid);

  // Normalize user text from postbacks
  let userText = text || '';
  if (raw?.postback?.payload) userText = raw.postback.payload;

  // Restart
  if (/^START OVER$/i.test(userText)) {
    sessions.delete(psid);
    await sendText(psid, 'Sige, start tayo ulit. 😊');
    return;
  }

  // Continue button just acknowledges
  if (/^CONTINUE$/i.test(userText)) {
    await sendText(psid, 'Game, itutuloy natin kung saan tayo huli.');
    return;
  }

  await sendTypingOn(psid);

  // If user taps any offers postback
  if (isPostback(raw, ['CHOOSE_', 'PHOTOS_', 'SHOW_OTHERS'])) {
    const out = await Offers.step(session, userText);
    if (out?.message) await sendText(psid, out.message);
    await sendTypingOff(psid);
    return;
  }

  // If qualifiers not complete, run LLM qualifier
  const qualDone = !!(session.qualifier?.payment && session.qualifier?.budget_number && session.qualifier?.location_city && session.qualifier?.transmission && session.qualifier?.body_type);

  if (!qualDone) {
    const out = await Qualifier.step(session, userText, raw);
    if (out?.message) await sendText(psid, out.message);
    // If done, immediately move to offers
    if (out?.done) {
      const o = await Offers.step(session, 'INIT');
      if (o?.message) await sendText(psid, o.message);
    }
    await sendTypingOff(psid);
    return;
  }

  // Already qualified → treat message as offers navigation
  const o = await Offers.step(session, userText);
  if (o?.message) await sendText(psid, o.message);

  await sendTypingOff(psid);
}

export const absorb = handleMessage; // for compatibility
