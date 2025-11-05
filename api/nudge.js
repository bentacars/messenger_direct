// api/nudge.js
export const config = { runtime: 'nodejs' };

import { getSession, saveSession } from '../server/lib/session.js';
import { aiNudge } from '../server/lib/llm.js';
import { sendText } from '../server/lib/messenger.js';

export default async function handler(req, res) {
  try {
    const psid = req.query.psid;
    if (!psid) return res.status(400).json({ ok: false, error: 'missing psid' });

    const state = await getSession(psid);
    if (!state) return res.status(200).json({ ok: true, note: 'no session' });

    // Quiet hours check + backoff handled inside aiNudge
    const txt = await aiNudge(state);
    if (txt) {
      await sendText(psid, txt);
      state._nudges = (state._nudges || 0) + 1;
      await saveSession(psid, state);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[nudge error]', err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
