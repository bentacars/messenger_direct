// /api/webhook.js
export const config = { runtime: 'nodejs' };

import { sendTypingOn, sendTypingOff } from '../server/lib/messenger.js';
import * as Router from '../server/flows/router.js'; // should export handleMessage

const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || '';

/* -------------------- GET: Verification -------------------- */
export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];

      if (mode === 'subscribe' && token === FB_VERIFY_TOKEN) {
        return res.status(200).send(challenge);
      }
      return res.status(403).send('Forbidden');
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const body = req.body || {};

    // Standard FB Messenger webhook payload
    if (body.object !== 'page' || !Array.isArray(body.entry)) {
      return res.status(200).json({ ok: true });
    }

    for (const entry of body.entry) {
      const messaging = entry.messaging || [];
      for (const evt of messaging) {
        const psid = evt.sender && evt.sender.id;
        if (!psid) continue;

        const text =
          (evt.message && evt.message.text) ||
          (evt.postback && evt.postback.title) ||
          '';

        const attachments =
          (evt.message && evt.message.attachments) ||
          (evt.postback && evt.postback.payload && JSON.parse(evt.postback.payload)?.attachments) ||
          [];

        // Typing indicator (brief)
        await sendTypingOn(psid);

        try {
          // Delegate to your main router (Phase 1 → 2 → 3 cash/financing)
          if (Router && typeof Router.handleMessage === 'function') {
            await Router.handleMessage({
              psid,
              text,
              raw: evt,
              attachments,
              postback: evt.postback || null
            });
          } else {
            // Fallback (shouldn't happen if router.js is in /server/flows)
            console.error('Router.handleMessage not found');
          }
        } catch (err) {
          console.error('handleMessage error', err);
        } finally {
          await sendTypingOff(psid);
        }
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('webhook error', err);
    return res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
}
