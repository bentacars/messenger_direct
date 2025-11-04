import { qualifierTurn } from './qualifier.js';
import { startOffers, pickOrOthers } from './offers.js';

export async function handleTurn(session, parsed) {
  // PHASE 1 (Qualifiers)
  if (session.phase === 'p1' || session.phase === 'p1_pending') {
    const r = qualifierTurn(session, parsed);
    if (r.done) {
      // Phase 2 entry point right after summary line from Part 1
      session.phase = 'p2_pending';
    }
    return r;
  }

  // PHASE 2 (Offers)
  if (session.phase === 'p2_pending') {
    await startOffers(session.psid, session);
    // startOffers will set phase -> p2_pick
    return { actions: [], done:true };
  }

  if (session.phase === 'p2_pick') {
    await pickOrOthers(session.psid, session, parsed.raw || '');
    return { actions: [], done:false };
  }

  // PHASE 3 will be added in Part 3
  return { actions: [{ type:'text', text:'Noted. Tuloy lang natin.' }], done:false };
}
