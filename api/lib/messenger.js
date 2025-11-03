// api/lib/messenger.js
const PAGE_TOKEN = process.env.FB_PAGE_TOKEN;
const FB_URL = 'https://graph.facebook.com/v18.0/me/messages';

async function fbSend(payload) {
  const url = `${FB_URL}?access_token=${encodeURIComponent(PAGE_TOKEN)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    console.error('FB send error', r.status, t);
  }
}

export async function sendText(psid, text) {
  return fbSend({ recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text } });
}

export async function sendImage(psid, url) {
  return fbSend({
    recipient: { id: psid },
    messaging_type: 'RESPONSE',
    message: {
      attachment: { type: 'image', payload: { url, is_reusable: false } }
    }
  });
}

export async function sendTypingOn(psid) {
  return fbSend({ recipient: { id: psid }, sender_action: 'typing_on' });
}
export async function sendTypingOff(psid) {
  return fbSend({ recipient: { id: psid }, sender_action: 'typing_off' });
}
