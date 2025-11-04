// api/nudge.js
import { getAllSessions, saveSession } from './lib/state.js';
import { maybeNudgePhase1, maybeNudgeDocs } from './lib/nudges.js';

export const config = { runtime: 'nodejs18.x' };

export default async function handler(req, res) {
  const sessions = getAllSessions(); // array of { psid, ... }
  for (const { psid, session } of sessions) {
    try {
      // Phase 1 nudges (only while in p1 or p1_pending)
      if (session.phase === 'p1' || session.phase === 'p1_pending') {
        await maybeNudgePhase1(psid, session);
        saveSession(psid, session);
        continue;
      }
      // Docs nudges (financing flow awaiting docs)
      if (session.phase === 'p3_fin' && session.docs && session.docs.awaiting) {
        await maybeNudgeDocs(psid, session);
        saveSession(psid, session);
        continue;
      }
    } catch (e) {
      console.error('nudge error for', psid, e);
    }
  }
  res.status(200).json({ ok: true, sessions: sessions.length });
}
