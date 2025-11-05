// api/webhook.js

import { route } from '../server/flows/router.js';
import { sendTypingOn, sendTypingOff } from '../server/lib/messenger.js';

const VERIFY = process.env.FB_VERIFY_TOKEN || '';

export default async function handler(req, res) {
  try {
    // Verification handshake
    if (req.method === 'GET') {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];
      if (mode === 'subscribe' && token === VERIFY) {
        return res.status(200).send(challenge);
      }
      return res.status(403).send('Forbidden');
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const body = req.body || {};
    if (!body.object || !Array.isArray(body.entry)) {
      return res.status(200).json({ ok: true }); // noop
    }

    for (const entry of body.entry) {
      for (const ev of entry.messaging || []) {
        const psid = ev.sender && ev.sender.id;
        if (!psid) continue;

        const messageText =
          (ev.message && (ev.message.text || ev.message.quick_reply?.payload)) ||
          (ev.postback && (ev.postback.payload || ev.postback.title)) ||
          '';

        try {
          await sendTypingOn(psid);
          await route({ psid, text: String(messageText || '').trim() });
        } catch (err) {
          console.error('[route/send error]', err);
        } finally {
          await sendTypingOff(psid);
        }
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[webhook error]', err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
