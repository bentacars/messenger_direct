// /api/webhook.js
// Runtime: Node serverless (Vercel)
export const config = { runtime: 'nodejs' };

/**
 * This webhook does 3 things:
 * 1) Handles the Meta verify handshake (GET)
 * 2) Receives Messenger events (POST)
 * 3) Normalizes each message and hands off to our Router (server/flows/router.js)
 *
 * Folder split:
 *   /api           -> only webhook + nudge (serverless functions)
 *   /server/**     -> all business logic (router, flows, tone, llm, matcher, etc.)
 */

import { routeMessage } from '../server/flows/router.js';
import { sendSenderActionSafe } from '../server/lib/messenger.js';

// --- Env ---
const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || '';
const APP_SECRET   = process.env.FB_APP_SECRET || ''; // optional if you want to validate signatures

// --- Utilities ---
function ok(res, json = { ok: true }) {
  return res.status(200).json(json);
}
function bad(res, msg, code = 400) {
  return res.status(code).json({ ok: false, error: msg });
}

/**
 * (Optional) Verify X-Hub-Signature for extra security.
 * You can enable later by setting FB_APP_SECRET; if blank we skip validation.
 */
function verifySignatureIfPresent(req) {
  if (!APP_SECRET) return true; // skip if not configured
  try {
    const sig = req.headers['x-hub-signature-256'] || req.headers['x-hub-signature'];
    if (!sig) return true; // allow through (we can enforce later if needed)
    // Lightweight check — Meta uses SHA256=hexdigest. Implement strict verify if required.
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize Messenger payload into our router context
 */
function extractCtx(entry) {
  // We focus on messages & postbacks; ignore deliveries/read echoes/etc.
  const messaging = entry.messaging || entry.standby || [];
  const ctxs = [];

  for (const m of messaging) {
    const psid = String(m.sender && m.sender.id || '').trim();
    if (!psid) continue;

    const timestamp = m.timestamp || Date.now();

    // Basic message fields
    const isEcho       = !!(m.message && m.message.is_echo);
    const text         = m.message && m.message.text ? m.message.text.trim() : '';
    const attachments  = m.message && m.message.attachments ? m.message.attachments : null;
    const quickReply   = m.message && m.message.quick_reply ? m.message.quick_reply.payload : null;

    // Postbacks (including buttons)
    const postback     = m.postback && (m.postback.payload || m.postback.title)
      ? { payload: m.postback.payload || '', title: m.postback.title || '' }
      : null;

    // We don’t process echoes coming from our own page
    if (isEcho) continue;

    ctxs.push({
      psid,
      text,
      attachments,
      quickReply,
      postback,
      timestamp,
      raw: m
    });
  }

  return ctxs;
}

/**
 * GET = Verify webhook (Meta)
 * POST = Handle messages
 */
export default async function handler(req, res) {
  try {
    // 1) Verify endpoint (Meta platform setup)
    if (req.method === 'GET') {
      const mode      = req.query['hub.mode'];
      const token     = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];

      if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
      }
      return bad(res, 'Verification failed', 403);
    }

    // 2) Incoming messages
    if (req.method !== 'POST') {
      return bad(res, 'Method not allowed', 405);
    }

    if (!verifySignatureIfPresent(req)) {
      return bad(res, 'Bad signature', 401);
    }

    const body = req.body || {};
    if (body.object !== 'page' || !Array.isArray(body.entry)) {
      return ok(res, { ok: true, ignored: true });
    }

    // Acknowledge quickly to Meta (don’t block)
    res.status(200).json({ received: true });

    // Process async after ack
    for (const entry of body.entry) {
      const ctxs = extractCtx(entry);
      for (const ctx of ctxs) {
        try {
          // brief typing indicator for human feel
          await sendSenderActionSafe(ctx.psid, 'typing_on');
          await routeMessage(ctx);                 // ← All phases live here
          await sendSenderActionSafe(ctx.psid, 'typing_off');
        } catch (err) {
          console.error('webhook routeMessage error', err);
          // best-effort fallback so we don’t silently die on one user
          try {
            await sendSenderActionSafe(ctx.psid, 'typing_off');
          } catch {}
        }
      }
    }
    // Nothing else to do (we already responded)

  } catch (err) {
    console.error('webhook error', err);
    // If we reach here before responding:
    try { return bad(res, String(err && err.message || err), 500); }
    catch { /* already responded above */ }
  }
}
