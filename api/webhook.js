import { sendText, sendTypingOn, sendTypingOff } from './lib/messenger.js';
import { getSession, saveSession, resetSession, markUserActivity } from './lib/state.js';
import { parseUtterance } from './lib/nlp.js';
import { handleTurn } from './flows/router.js';

export const config = { runtime: 'nodejs18.x' };

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];
      if (mode === 'subscribe' && token === process.env.FB_VERIFY_TOKEN) {
        return res.status(200).send(challenge);
      }
      return res.status(403).send('Forbidden');
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      if (body.object !== 'page') return res.status(200).send('ignored');

      const entries = body.entry || [];
      for (const entry of entries) {
        const messaging = entry.messaging || [];
        for (const evt of messaging) {
          const psid = evt.sender?.id;
          if (!psid) continue;

          // incoming text (ignore delivery, read, etc.)
          const userText = evt.message?.text || evt.postback?.title || '';
          if (!userText) { continue; }

          // restart command
          if (userText.trim().toLowerCase() === 'restart') {
            resetSession(psid);
          }

          // session
          const s = getSession(psid);
          s.psid = psid;
          s.isReturning = Boolean(s.createdAt && (Date.now() - s.createdAt > 1000)); // naive returning

          // parse user text
          const parsed = parseUtterance(userText);
          markUserActivity(psid);

          // typing on
          await sendTypingOn(psid);

          const result = await handleTurn(s, parsed);

          // send actions
          for (const act of result.actions) {
            if (act.type === 'text') await sendText(psid, act.text);
          }

          await sendTypingOff(psid);
          saveSession(psid, s);
        }
      }
      return res.status(200).send('EVENT_RECEIVED');
    }

    return res.status(405).send('Method Not Allowed');
  } catch (err) {
    console.error('webhook error', err);
    return res.status(500).send('Internal');
  }
}
