// api/flows/router.js
import { qualifierTurn } from './qualifier.js';
import { startOffers, pickOrOthers } from './offers.js';
import { cashEntry, cashHandle, cashTryCaptureContact, cashAddressGate } from './cash.js';
import { finEntry, finHandle, finTryCaptureContact, finAddressGate } from './financing.js';
import { faqMiddleware } from '../lib/middleware.js';

export async function handleTurn(session, parsed, ctx = {}) {
  const raw = parsed.raw || '';
  const atts = ctx.attachments || [];

  // ===== Global middleware (FAQs / Rebuttals) =====
  // Let middleware answer quickly; if handled, return.
  if (await faqMiddleware(session.psid, session, raw)) {
    return { actions: [], done: false };
  }

  // ===== Phase 1: Qualifiers =====
  if (session.phase === 'p1' || session.phase === 'p1_pending' || !session.phase) {
    const r = qualifierTurn(session, parsed);
    if (r.done) session.phase = 'p2_pending';
    return r;
  }

  // ===== Phase 2: Offers =====
  if (session.phase === 'p2_pending') {
    await startOffers(session.psid, session);
    return { actions: [], done: true };
  }

  if (session.phase === 'p2_pick') {
    await pickOrOthers(session.psid, session, raw);
    if (session.phase === 'p3_cash') await cashEntry(session.psid, session);
    if (session.phase === 'p3_fin')  await finEntry(session.psid, session);
    return { actions: [], done: false };
  }

  // ===== Phase 3: CASH =====
  if (session.phase === 'p3_cash') {
    if (
      /address|saan|location|tamang lugar/i.test(raw) &&
      (!session.contact || !session.contact.mobile || !session.contact.fullname)
    ) {
      await cashAddressGate(session.psid);
      return { actions: [], done: false };
    }
    cashTryCaptureContact(session, raw);
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
    finTryCaptureContact(session, raw);
    await finHandle(session.psid, session, raw, atts);
    return { actions: [], done: false };
  }

  // ===== Default fallback =====
  return { actions: [{ type: 'text', text: 'Noted. Tuloy lang natin.' }], done: false };
}
