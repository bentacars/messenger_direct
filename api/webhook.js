// /api/webhook.js
export const config = { runtime: 'nodejs' };

import { route } from '../server/flows/router.js'; // <-- adjust if needed

const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || '';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || '';

/* -------------------- Minimal Graph API helpers -------------------- */
async function callSendAPI(body) {
  const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('Send API error:', res.status, text);
  }
}

async function sendToMessenger(psid, message) {
  return callSendAPI({ recipient: { id: psid }, message });
}

async function sendTypingOn(psid) {
  return callSendAPI({ recipient: { id: psid }, sender_action: 'typing_on' });
}

async function sendTypingOff(psid) {
  return callSendAPI({ recipient: { id: psid }, sender_action: 'typing_off' });
}

/* -------------------- Router → Messenger payload mapper -------------------- */
async function sendMessages(psid, messages = []) {
  for (const m of messages) {
    if (!m) continue;

    // Plain text
    if (m.type === 'text' && m.text) {
      await sendToMessenger(psid, { text: m.text.slice(0, 2000) });
      continue;
    }

    // Buttons → Button Template
    if (m.type === 'buttons' && m.text && Array.isArray(m.buttons)) {
      const buttons = m.buttons.slice(0, 3).map(b => {
        if (b?.url) {
          return { type: 'web_url', title: (b.title || 'Open').slice(0, 20), url: b.url };
        }
        return {
          type: 'postback',
          title: (b.title || b.payload || 'Select').slice(0, 20),
          payload: String(b.payload || b.title || 'BTN'),
        };
      });

      await sendToMessenger(psid, {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text: m.text.slice(0, 640),
            buttons,
          },
        },
      });
      continue;
    }

    // Carousel / Generic Template passthrough
    if (m.type === 'generic' && Array.isArray(m.elements)) {
      await sendToMessenger(psid, {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'generic',
            elements: m.elements,
          },
        },
      });
      continue;
    }

    // Single Image
    if (m.type === 'image' && (m.url || m.image_url)) {
      await sendToMessenger(psid, {
        attachment: {
          type: 'image',
          payload: { url: m.url || m.image_url, is_reusable: true },
        },
      });
      continue;
    }

    // Quick replies (optional support if you emit m.quick_replies)
    if (m.type === 'quick_replies' && m.text && Array.isArray(m.replies)) {
      const quick_replies = m.replies.slice(0, 11).map(r => ({
        content_type: 'text',
        title: String(r.title || r).slice(0, 20),
        payload: String(r.payload || r.title || r).slice(0, 1000),
      }));
      await sendToMessenger(psid, { text: m.text.slice(0, 640), quick_replies });
      continue;
    }

    // Fallback: stringify unknown payloads
    await sendToMessenger(psid, {
      text: typeof m === 'string' ? m : `Unsupported message:\n${safeStringify(m).slice(0, 1800)}`
    });
  }
}

/* -------------------- In-memory sessions per PSID -------------------- */
const SESSIONS = new Map();

/* -------------------- Webhook Handler -------------------- */
export default async function handler(req, res) {
  try {
    // GET: Verification (Meta)
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
      // Messenger sometimes pings; ACK politely
      return res.status(200).json({ ok: true });
    }

    for (const entry of body.entry) {
      const messaging = entry.messaging || [];
      for (const evt of messaging) {
        const psid = evt?.sender?.id;
        if (!psid) continue;

        const text =
          evt?.message?.text ??
          // Prefer postback payload (machine-readable) over title
          (typeof evt?.postback?.payload === 'string' ? evt.postback.payload : undefined) ??
          evt?.postback?.title ??
          '';

        await sendTypingOn(psid);

        try {
          const session = SESSIONS.get(psid) ?? { psid };
          const { session: newSession, messages } = await route(session, text, evt);
          SESSIONS.set(psid, newSession);
          await sendMessages(psid, messages);
        } catch (err) {
          console.error('route/send error', err);
          await sendToMessenger(psid, { text: "Oops—nagka-issue saglit. Try uli in a bit? 🙏" });
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

/* -------------------- utils -------------------- */
function safeStringify(x) {
  try { return JSON.stringify(x, null, 2); } catch { return String(x); }
}
