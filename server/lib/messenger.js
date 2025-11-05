// server/lib/messenger.js
import { fetch } from 'undici';

const PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN || '';

const FB_SEND = 'https://graph.facebook.com/v19.0/me/messages';
const FB_PROFILE = 'https://graph.facebook.com/v19.0/';

async function fbPost(url, body) {
  const r = await fetch(`${url}?access_token=${PAGE_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const txt = await r.text();
  if (!r.ok) {
    console.error('Send API error:', r.status, txt);
  }
  return txt;
}

export async function sendTypingOn(psid) {
  return fbPost(FB_SEND, { recipient: { id: psid }, sender_action: 'typing_on' });
}
export async function sendTypingOff(psid) {
  return fbPost(FB_SEND, { recipient: { id: psid }, sender_action: 'typing_off' });
}

export async function sendText(psid, text, quick_replies = null) {
  const message = { text };
  if (quick_replies?.length) message.quick_replies = quick_replies;
  return fbPost(FB_SEND, { recipient: { id: psid }, messaging_type: 'RESPONSE', message });
}

export async function sendButtons(psid, text, buttons) {
  const payload = {
    recipient: { id: psid },
    messaging_type: 'RESPONSE',
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text,
          buttons
        }
      }
    }
  };
  return fbPost(FB_SEND, payload);
}

export async function sendImage(psid, url) {
  const payload = {
    recipient: { id: psid },
    message: {
      attachment: {
        type: 'image',
        payload: { url, is_reusable: false }
      }
    }
  };
  return fbPost(FB_SEND, payload);
}

export async function sendGenericTemplate(psid, elements) {
  const payload = {
    recipient: { id: psid },
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'generic',
          elements
        }
      }
    }
  };
  return fbPost(FB_SEND, payload);
}

export async function getProfileName(psid) {
  // This requires the app capability; if not granted, we fail gracefully.
  try {
    const r = await fetch(`${FB_PROFILE}${psid}?fields=first_name,last_name&access_token=${PAGE_TOKEN}`);
    if (!r.ok) return null;
    const j = await r.json();
    const first = j.first_name?.trim() || '';
    const last = j.last_name?.trim() || '';
    const name = [first, last].filter(Boolean).join(' ').trim();
    return name || null;
  } catch (e) {
    return null;
  }
}
