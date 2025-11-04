// api/flows/router.js
import { qualifierTurn } from './qualifier.js';
import { startOffers, pickOrOthers } from './offers.js';
import { cashEntry, cashHandle, cashTryCaptureContact, cashAddressGate } from './cash.js';
import { finEntry, finHandle, finTryCaptureContact, finAddressGate } from './financing.js';

/**
 * Central turn router.
 * - Phase 1: Qualifiers (conversational; asks missing only)
 * - Phase 2: Offers (2 first, then "others" → up to 2 more)
 * - Phase 3: Cash / Financing flows (schedule → contact → address; then income/docs for financing)
 *
 * @param {object} session - per-user session state
 * @param {object} parsed  - { raw, plan, budget, location, transmission, body_type, ... }
 * @param {object} ctx     - { attachments: [...] }
 * @returns {Promise<{actions: Array, done: boolean}>}
 */
export async function handleTurn(session, parsed, ctx = {}) {
  const raw = parsed.raw || '';
  const atts = ctx.attachments || [];

  // ===== Phase 1: Qualifiers =====
  if (session.phase === 'p1' || session.phase === 'p1_pending' || !session.phase) {
    const r = qualifierTurn(session, parsed);
    if (r.done) {
      // Directly proceed to Phase 2 on next tick
      session.phase = 'p2_pending';
    }
    return r;
  }

  // ===== Phase 2: Offers =====
  if (session.phase === 'p2_pending') {
    await startOffers(session.psid, session);
    // startOffers sets session.phase = 'p2_pick'
    return { actions: [], done: true };
  }

  if (session.phase === 'p2_pick') {
    await pickOrOthers(session.psid, session, raw);
    // If user chose a unit, offers.js will set:
    //   session.phase = 'p3_cash' or 'p3_fin' and send gallery.
    // We enter Phase 3 flow immediately after showing gallery:
    if (session.phase === 'p3_cash') await cashEntry(session.psid, session);
    if (session.phase === 'p3_fin')  await finEntry(session.psid, session);
    return { actions: [], done: false };
  }

  // ===== Phase 3: CASH =====
  if (session.phase === 'p3_cash') {
    // Guard: asking for address before contact data
    if (
      /address|saan|location|tamang lugar/i.test(raw) &&
      (!session.contact || !session.contact.mobile || !session.contact.fullname)
    ) {
      await cashAddressGate(session.psid);
      return { actions: [], done: false };
    }

    // Opportunistic contact capture from free text
    cashTryCaptureContact(session, raw);

    // Main handler (schedule → contact → address)
    await cashHandle(session.psid, session, raw);
    return { actions: [], done: false };
  }

  // ===== Phase 3: FINANCING =====
  if (session.phase === 'p3_fin') {
    if (
      /address|saan|location|tamang lugar/i.test(raw) &&
      (!session.contact || !session.contact.mobile || !session.contact.fullname)
    ) {
      await finAddressGate(session.psid);
      return { actions: [], done: false };
    }

    // Try capture contact opportunistically
    finTryCaptureContact(session, raw);

    // Main handler (schedule → contact → address → income → docs)
    await finHandle(session.psid, session, raw, atts);
    return { actions: [], done: false };
  }

  // ===== Default fallback =====
  return { actions: [{ type: 'text', text: 'Noted. Tuloy lang natin.' }], done: false };
}
