// server/lib/messenger.js
// Wrapper for Facebook Messenger Send API
// Handles sending text, buttons, images, and routing to bot core
// Ensures safe JSON/session/save (no circular structures)

import fetch from 'node-fetch';
import { getState, setState, resetState } from './state.js';

const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN;
const FB_PROFILE_URL = `https://graph.facebook.com/v17.0/me/messages`;

if (!FB_PAGE_TOKEN) {
  console.warn('[messenger] Missing FB_PAGE_TOKEN');
}

/* ================= CORE SEND HELPERS ================= */

async function fbSend(psid, payload) {
  const res = await fetch(FB_PROFILE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      recipient: { id: psid },
      message: payload,
      messaging_type: 'RESPONSE',
      access_token: FB_PAGE_TOKEN,
    }),
  });

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    console.error('[fbSend]', res.status, text);
  }
}

/** Send typing indicator */
export async function sendTyping(psid, on = true) {
  await fetch(FB_PROFILE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: psid },
      sender_action: on ? 'typing_on' : 'typing_off',
      access_token: FB_PAGE_TOKEN,
    }),
  });
}

/** Send plain text */
export async function sendText(psid, text) {
  await fbSend(psid, { text });
}

/** Send a button template */
export async function sendButtons(psid, text, buttons) {
  await fbSend(psid, {
    attachment: {
      type: 'template',
      payload: {
        template_type: 'button',
        text,
        buttons,
      },
    },
  });
}

/** Send image(s) one by one */
export async function sendImages(psid, urls = []) {
  for (const u of urls) {
    if (!u) continue;
    await fbSend(psid, {
      attachment: {
        type: 'image',
        payload: {
          url: u,
          is_reusable: true,
        },
      },
    });
  }
}

/* ===================== MAIN WEBHOOK DISPATCH ===================== */

// Safely extract text from webhook event
function extractText(evt) {
  return (
    (evt.message && evt.message.text) ||
    (evt.postback && evt.postback.title) ||
    ''
  );
}

// Safely extract attachments
function extractAttachments(evt) {
  const at = evt?.message?.attachments;
  return Array.isArray(at) ? at : [];
}

/**
 * handleWebhook
 * Called by api/webhook.js
 *  1) loads session
 *  2) sends to router
 *  3) dispatches router messages
 */
export async function handleWebhook(psid, evt, routerFn) {
  const userText = extractText(evt) || '';
  const attachments = extractAttachments(evt);

  const safeRaw = {
    postback: evt.postback?.payload || null,
    quick_reply: evt.message?.quick_reply?.payload || null,
  };

  // ✅ Load existing state (or empty)
  const st = (await getState(psid)) || {};

  // ✅ Router does the logic (Phase 1 → 2 → 3 etc.)
  const result = await routerFn({
    psid,
    text: userText,
    raw: safeRaw, // stripped of circular refs
    attachments,
    state: st,
  });

  const { replies = [], newState = null, reset = false } = result || {};

  // Save/reset state
  if (reset) {
    await resetState(psid);
  } else if (newState) {
    await setState(psid, newState); // ✅ safe merge + JSON
  }

  // Deliver replies in sequence
  for (const r of replies) {
    if (!r || !r.type) continue;
    switch (r.type) {
      case 'text':
        await sendText(psid, r.text);
        break;
      case 'buttons':
        await sendButtons(psid, r.text, r.buttons);
        break;
      case 'images':
        await sendImages(psid, r.urls);
        break;
    }
  }
}
