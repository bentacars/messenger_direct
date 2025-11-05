// server/flows/router.js
import { getSession, saveSession, clearSession } from '../lib/session.js';
import { sendText, sendButtons } from '../lib/messenger.js';
import { handleInterrupts } from '../lib/interrupts.js';
import { welcome } from './qualifier.js';
import { phase1 } from './qualifier.js';
import { showOffers, handleOffersAction } from './offers.js';
import { cashFlow } from './cash.js';
import { financingFlow } from './financing.js';
import { initIfNeeded, applyExtraction, missingFields } from '../lib/state.js';
import { extractQualifiers } from '../lib/llm.js';

export async function route({ psid, text }) {
  let s = await getSession(psid);
  s = initIfNeeded(s);

  // Commands
  if (/^start over$/i.test(text)) {
    await clearSession(psid);
    s = initIfNeeded({});
    await welcome({ psid, returning: false });
    return await saveSession(psid, s);
  }
  if (/^continue$/i.test(text)) {
    await sendText(psid, "Sige, itutuloy ko kung saan tayo huli.");
  }

  // First touch welcome
  if (!s._welcomed) {
    const returning = !!s._updated_at && (Date.now() - (s._updated_at || 0) < 7 * 86400000);
    await welcome({ psid, returning });
    s._welcomed = true;
    await saveSession(psid, s);
    if (!text) return;
  }

  // Interrupts (FAQ, objections, offtopic)
  const intr = await handleInterrupts({ utterance: text, state: s });
  if (intr.handled) {
    await sendText(psid, intr.text);
    // then continue flow without resetting
  }

  // Route by phase
  if (s.phase === 'qualifying') {
    const result = await phase1({ psid, state: s, text });
    await saveSession(psid, s);
    if (result.done) {
      await showOffers({ psid, state: s });
      await saveSession(psid, s);
    }
    return;
  }

  if (s.phase === 'matching' || s.phase === 'offers') {
    // Try to absorb new info while browsing offers (e.g., “qc sedan”)
    const ex = await extractQualifiers(text);
    applyExtraction(s, ex);
    if (/^others$/i.test(text) || /^choose_/i.test(text) || /^widen$/i.test(text)) {
      await handleOffersAction({ psid, state: s, text });
    } else if (missingFields(s).length === 0 && s.phase !== 'offers') {
      await showOffers({ psid, state: s });
    }
    await saveSession(psid, s);
    return;
  }

  if (s.phase === 'cash_flow') {
    await cashFlow({ psid, state: s, text });
    await saveSession(psid, s);
    return;
  }

  if (s.phase === 'financing_flow') {
    await financingFlow({ psid, state: s, text });
    await saveSession(psid, s);
    return;
  }

  // Fallback
  await sendText(psid, "Hi ulit! Looking for something specific? How can I help you today?");
  await saveSession(psid, s);
}
