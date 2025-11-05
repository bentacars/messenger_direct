// api/webhook.js
export const config = { runtime: 'nodejs' };

import { sendTypingOn, sendTypingOff } from '../server/lib/messenger.js';
import { handleMessage } from '../server/flows/router.js';

const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || '';

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
    if (body.object !== 'page' || !Array.isArray(body.entry)) {
      return res.status(200).json({ ok: true });
    }

    for (const entry of body.entry) {
      for (const evt of entry.messaging || []) {
        const psid = evt.sender && evt.sender.id;
        if (!psid) continue;

        const text =
          (evt.message && evt.message.text) ||
          (evt.postback && evt.postback.title) || '';

        await sendTypingOn(psid);
        try {
          await handleMessage({ psid, text, raw: evt });
        } catch (err) {
          console.error('route/send error', err);
        } finally {
          await sendTypingOff(psid);
        }
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('webhook error', err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
