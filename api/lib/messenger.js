// api/lib/messenger.js (ESM)
const FB_API = 'https://graph.facebook.com/v17.0/me/messages';

function getToken() {
  const t = process.env.FB_PAGE_TOKEN;
  if (!t) throw new Error('Missing FB_PAGE_TOKEN');
  return t;
}

function isValidPsid(v) {
  // FB PSIDs are numeric strings
  return typeof v === 'string' && /^[0-9]{5,}$/.test(v);
}

export function validatePsid(psid) {
  if (!isValidPsid(psid)) {
    throw new Error(`Invalid PSID: "${psid}"`);
  }
  return psid;
}

async function callSendAPI(payload) {
  const token = getToken();
  const url = `${FB_API}?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`FB send error ${res.status} ${JSON.stringify(j)}`);
  }
  return j;
}

export async function sendTypingOn(psid) {
  validatePsid(psid);
  return callSendAPI({ recipient: { id: psid }, sender_action: 'typing_on' });
}
export async function sendTypingOff(psid) {
  validatePsid(psid);
  return callSendAPI({ recipient: { id: psid }, sender_action: 'typing_off' });
}

export async function sendText(psid, text) {
  validatePsid(psid);
  return callSendAPI({
    recipient: { id: psid },
    message: { text }
  });
}

export async function sendImage(psid, url) {
  validatePsid(psid);
  return callSendAPI({
    recipient: { id: psid },
    message: {
      attachment: {
        type: 'image',
        payload: { url, is_reusable: false }
      }
    }
  });
}

export async function sendQuickReplies(psid, text, replies) {
  validatePsid(psid);
  return callSendAPI({
    recipient: { id: psid },
    message: {
      text,
      quick_replies: replies.map(r => ({
        content_type: 'text',
        title: r.title?.slice(0, 20) || r.payload,
        payload: r.payload
      }))
    }
  });
}
