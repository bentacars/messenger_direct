// /server/lib/messenger.js
// Minimal Messenger helpers: send, typing, and user profile lookup

const PAGE_TOKEN = process.env.FB_PAGE_TOKEN || '';
const GRAPH_BASE = process.env.FB_GRAPH_BASE || 'https://graph.facebook.com/v19.0';

if (!PAGE_TOKEN) {
  console.warn('[messenger] FB_PAGE_TOKEN is missing');
}

/* -------------------- Low-level Send API -------------------- */
async function callSendAPI(body) {
  const url = `${GRAPH_BASE}/me/messages?access_token=${encodeURIComponent(PAGE_TOKEN)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error('Send API error:', res.status, errText);
    throw new Error(`Send API ${res.status}`);
  }
  return res.json();
}

/* -------------------- Typing indicators -------------------- */
export async function sendTypingOn(psid) {
  if (!psid) return;
  return callSendAPI({ recipient: { id: psid }, sender_action: 'typing_on' });
}
export async function sendTypingOff(psid) {
  if (!psid) return;
  return callSendAPI({ recipient: { id: psid }, sender_action: 'typing_off' });
}

/* -------------------- Message helpers used by webhook -------------------- */
export async function sendText(psid, text) {
  if (!psid || !text) return;
  return callSendAPI({
    recipient: { id: psid },
    messaging_type: 'RESPONSE',
    message: { text }
  });
}
export async function sendImage(psid, url) {
  if (!psid || !url) return;
  return callSendAPI({
    recipient: { id: psid },
    messaging_type: 'RESPONSE',
    message: { attachment: { type: 'image', payload: { url, is_reusable: false } } }
  });
}
export async function sendButtons(psid, text, buttons) {
  if (!psid || !text) return;
  return callSendAPI({
    recipient: { id: psid },
    messaging_type: 'RESPONSE',
    message: {
      attachment: {
        type: 'template',
        payload: { template_type: 'button', text, buttons }
      }
    }
  });
}
export async function sendGenericTemplate(psid, elements) {
  if (!psid || !elements?.length) return;
  return callSendAPI({
    recipient: { id: psid },
    messaging_type: 'RESPONSE',
    message: {
      attachment: {
        type: 'template',
        payload: { template_type: 'generic', elements }
      }
    }
  });
}

/* -------------------- User Profile API (name lookup) -------------------- */
/**
 * Returns { first_name, last_name, profile_pic } or null.
 * Works in Development for app/page roles + testers; in Live for everyone.
 */
const _profileCache = new Map(); // psid -> { data, ts }
const CACHE_MS = 24 * 60 * 60 * 1000; // 24h

export async function getUserProfile(psid) {
  if (!psid) return null;
  const hit = _profileCache.get(psid);
  if (hit && Date.now() - hit.ts < CACHE_MS) return hit.data;

  const url = `${GRAPH_BASE}/${encodeURIComponent(psid)}?fields=first_name,last_name,profile_pic&access_token=${encodeURIComponent(PAGE_TOKEN)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      // common causes: invalid token, user not eligible in dev mode
      const t = await res.text().catch(() => '');
      console.warn('Profile API warn:', res.status, t);
      return null;
    }
    const j = await res.json();
    const data = {
      first_name: j.first_name || '',
      last_name: j.last_name || '',
      profile_pic: j.profile_pic || ''
    };
    _profileCache.set(psid, { data, ts: Date.now() });
    return data;
  } catch (e) {
    console.warn('Profile API error:', e?.message || e);
    return null;
  }
}

export default {
  sendTypingOn,
  sendTypingOff,
  sendText,
  sendImage,
  sendButtons,
  sendGenericTemplate,
  getUserProfile,
};
