// api/lib/messenger.js
// Minimal FB Messenger sender helpers (Graph API v18+)

const PAGE_TOKEN = process.env.FB_PAGE_TOKEN || '';

function assertToken() {
  if (!PAGE_TOKEN) throw new Error('FB_PAGE_TOKEN is missing');
}
function isValidPsid(psid) {
  return typeof psid === 'string' && /^[0-9]{5,}$/.test(psid);
}
export function validatePsid(psid) {
  if (!isValidPsid(psid)) {
    throw new Error(`Invalid PSID: "${String(psid)}"`);
  }
}

async function fbSend(body) {
  assertToken();
  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${encodeURIComponent(PAGE_TOKEN)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`FB send error ${r.status} ${text}`);
  }
  return r.json().catch(() => ({}));
}

export async function sendTypingOn(psid) {
  validatePsid(psid);
  return fbSend({ recipient: { id: psid }, sender_action: 'typing_on' });
}
export async function sendTypingOff(psid) {
  validatePsid(psid);
  return fbSend({ recipient: { id: psid }, sender_action: 'typing_off' });
}
export async function sendText(psid, text, quickReplies /* optional */) {
  validatePsid(psid);
  const message = { text };
  if (Array.isArray(quickReplies) && quickReplies.length) {
    message.quick_replies = quickReplies.slice(0, 11).map((t) => ({
      content_type: 'text',
      title: String(t).slice(0, 20),
      payload: `QR::${t}`,
    }));
  }
  return fbSend({ recipient: { id: psid }, message });
}
export async function sendImage(psid, imageUrl) {
  validatePsid(psid);
  return fbSend({
    recipient: { id: psid },
    message: {
      attachment: {
        type: 'image',
        payload: { url: imageUrl, is_reusable: true },
      },
    },
  });
}
export async function sendButtons(psid, text, buttons) {
  validatePsid(psid);
  return fbSend({
    recipient: { id: psid },
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text,
          buttons: buttons.slice(0, 3).map((b) => ({
            type: 'postback',
            title: b.title.slice(0, 20),
            payload: b.payload.slice(0, 100),
          })),
        },
      },
    },
  });
}
