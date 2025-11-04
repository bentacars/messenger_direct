// api/webhook.js
import { sendText, sendTypingOn, sendTypingOff } from './lib/messenger.js';
import { getSession, saveSession, resetSession, markUserActivity } from './lib/state.js';
import { parseUtterance } from './lib/nlp.js';
import { handleTurn } from './flows/router.js';

export const config = { runtime: 'nodejs18.x' };

export default async function handler(req, res) {
  try {
    // --- Facebook webhook verification (GET) ---
    if (req.method === 'GET') {
      const mode = req.query?.['hub.mode'];
      const token = req.query?.['hub.verify_token'];
      const challenge = req.query?.['hub.challenge'];

      if (mode === 'subscribe' && token === process.env.FB_VERIFY_TOKEN) {
        return res.status(200).send(challenge);
      }
      return res.status(403).send('Forbidden');
    }

    // --- Webhook events (POST) ---
    if (req.method === 'POST') {
      const body = req.body || {};
      if (body.object !== 'page') {
        return res.status(200).send('ignored');
      }

      const entries = body.entry || [];
      for (const entry of entries) {
        const messaging = entry.messaging || [];
        for (const evt of messaging) {
          const psid = evt.sender?.id;
          if (!psid) continue;

          const userText =
            evt.message?.text ??
            evt.postback?.title ??
            ''; // keep it simple (buttons not used, but safe)

          // Attachments (for financing docs, images/files, etc.)
          const attachments = evt.message?.attachments || [];

          // Empty messages (read receipts, delivery, etc.)
          if (!userText && !attachments.length) continue;

          // Restart command
          const rawLower = String(userText || '').trim().toLowerCase();
          if (rawLower === 'restart' || rawLower === '/restart') {
            resetSession(psid);
          }

          // Session bootstrap
          const s = getSession(psid);
          s.psid = psid;

          // Parse text
          const parsed = parseUtterance(userText || '');
          parsed.raw = userText || '';

          // Activity timestamp (for nudges/timers)
          markUserActivity(psid);

          // Typing indicator
          await sendTypingOn(psid);

          // Route to the current phase handler
          const result = await handleTurn(s, parsed, { attachments });

          // Send any returned actions (most Phase 2/3 send directly; Phase 1 returns actions)
          if (result && Array.isArray(result.actions)) {
            for (const act of result.actions) {
              if (act.type === 'text' && act.text) {
                await sendText(psid, act.text);
              }
            }
          }

          await sendTypingOff(psid);
          saveSession(psid, s);
        }
      }

      return res.status(200).send('EVENT_RECEIVED');
    }

    // Fallback
    return res.status(405).send('Method Not Allowed');
  } catch (err) {
    console.error('webhook error', err);
    return res.status(500).send('Internal');
  }
}
