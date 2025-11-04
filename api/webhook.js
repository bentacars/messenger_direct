// api/webhook.js
// Vercel Node serverless webhook for Facebook Messenger

export const config = { runtime: 'nodejs' };

import { sendText, sendTypingOn, sendTypingOff, sendButtons } from './lib/messenger.js';
import * as Router from './flows/router.js';

// --- KV (Upstash REST via Vercel KV Integration) ---
const KV_URL   = process.env.KV_REST_API_URL || process.env.KV_REST_API_KV_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.KV_REST_API_READ_ONLY_TOKEN || '';

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const data = await r.json().catch(() => null);
  const raw = data?.result ?? null;
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}
async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(body)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  return r.ok;
}

// session helpers
async function loadSession(psid) {
  const key = `session:${psid}`;
  const s = (await kvGet(key)) || {};
  s.psid = psid;
  s.lastActivityTs = Date.now();
  return s;
}
async function saveSession(sess) {
  const key = `session:${sess.psid}`;
  await kvSet(key, sess);
}

// --- VERIFY (GET) ---
export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || '';
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];
      if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
      }
      return res.status(403).send('Verification failed');
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    }

    const body = req.body || {};
    if (body.object !== 'page' || !Array.isArray(body.entry)) {
      return res.status(200).json({ ok: true, note: 'Not a page event' });
    }

    // Iterate messaging events
    for (const entry of body.entry) {
      const messaging = entry.messaging || [];
      for (const evt of messaging) {
        const senderId = evt?.sender?.id;
        if (!senderId) continue;

        const sess = await loadSession(senderId);

        // Detect restart (typed "restart")
        const maybeText = evt.message?.text?.trim().toLowerCase() || evt.postback?.payload?.trim().toLowerCase() || '';
        if (maybeText === 'restart' || maybeText === 'start over' || maybeText === 'qr::start over') {
          sess.phase = 'phase1';
          sess.qualifier = {};
          sess.funnel = {};
          await saveSession(sess);
          await sendTypingOn(senderId);
          await sendText(senderId, 'Reset na. Let’s start fresh. 🙂');
          await sendTypingOff(senderId);
          // Continue to router asking only missing fields
        }

        // Extract user utterance (text only for now)
        const text = evt.message?.text || evt.postback?.title || evt.postback?.payload || '';

        // Route
        const out = await Router.route(sess, text, evt);

        // Persist updated session
        await saveSession(out.session);

        // Emit all outbound messages (already humanized by Router)
        for (const m of out.messages) {
          await sendTypingOn(senderId);
          if (m.type === 'buttons') {
            await sendButtons(senderId, m.text, m.buttons);
          } else {
            await sendText(senderId, m.text, m.quickReplies);
          }
          await sendTypingOff(senderId);
        }
      }
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('webhook error', err);
    return res.status(200).json({ ok: true }); // keep 200 so FB won’t retry aggressively
  }
}
