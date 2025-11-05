// api/webhook.js
export const config = { runtime: 'nodejs' };

import { handleMessage } from '../server/flows/router.js';
import { sendTypingOn, sendTypingOff } from '../server/lib/messenger.js';

const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || 'dev';

function getTextFromEvent(evt) {
  const msg = evt.message || {};
  if (msg.quick_reply?.payload) return String(msg.quick_reply.payload);
  if (typeof msg.text === 'string') return msg.text;
  if (evt.postback?.payload) return String(evt.postback.payload);
  if (evt.postback?.title) return String(evt.postback.title);
  return '';
}

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
      return res.status(405).json({ ok:false, error:'Method not allowed' });
    }

    const body = req.body || {};
    if (body.object !== 'page' || !Array.isArray(body.entry)) {
      return res.status(200).json({ ok:true });
    }

    for (const entry of body.entry) {
      for (const evt of entry.messaging || []) {
        const psid = evt.sender?.id;
        if (!psid) continue;
        const text = (getTextFromEvent(evt) || '').trim();

        await sendTypingOn(psid);
        try {
          await handleMessage({ psid, userText:text, rawEvent:evt });
        } catch (e) {
          console.error('webhook/handleMessage error', e);
        } finally {
          await sendTypingOff(psid);
        }
      }
    }

    return res.status(200).json({ ok:true });
  } catch (e) {
    console.error('webhook error', e);
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
}
