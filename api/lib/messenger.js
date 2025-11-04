// api/lib/messenger.js
const FB_URL = 'https://graph.facebook.com/v19.0/me/messages';

function validatePsid(psid) {
  const s = (psid ?? '').toString().trim();
  if (!s || !/^\d+$/.test(s)) {
    throw new Error('Invalid PSID: ' + JSON.stringify(psid));
  }
  return s;
}

async function callSendAPI(pageToken, payload) {
  const url = `${FB_URL}?access_token=${pageToken}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    console.error('FB send error', r.status, t);
    throw new Error(`FB send ${r.status}`);
  }
  return r.json().catch(() => ({}));
}

export async function sendTypingOn(pageToken, psid) {
  const id = validatePsid(psid);
  return callSendAPI(pageToken, {
    recipient: { id },
    sender_action: 'typing_on'
  });
}

export async function sendTypingOff(pageToken, psid) {
  const id = validatePsid(psid);
  return callSendAPI(pageToken, {
    recipient: { id },
    sender_action: 'typing_off'
  });
}

export async function sendText(pageToken, psid, text) {
  const id = validatePsid(psid);
  return callSendAPI(pageToken, {
    recipient: { id },
    messaging_type: 'RESPONSE',
    message: { text: String(text ?? '').slice(0, 2000) }
  });
}

export async function sendImage(pageToken, psid, imageUrl) {
  const id = validatePsid(psid);
  return callSendAPI(pageToken, {
    recipient: { id },
    messaging_type: 'RESPONSE',
    message: {
      attachment: {
        type: 'image',
        payload: { url: String(imageUrl), is_reusable: false }
      }
    }
  });
}
