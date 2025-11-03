// /api/lib/messenger.js
const FB_API = 'https://graph.facebook.com/v18.0/me/messages';

function fbParams(token) {
  return { access_token: token };
}

async function callSendAPI(pageToken, payload) {
  const url = new URL(FB_API);
  url.search = new URLSearchParams(fbParams(pageToken)).toString();
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('FB send error', res.status, data);
    throw new Error(`FB send failed ${res.status}`);
  }
  return data;
}

export async function sendText(pageToken, psid, text) {
  return callSendAPI(pageToken, {
    recipient: { id: psid },
    messaging_type: 'RESPONSE',
    message: { text },
  });
}

export async function sendQuickReplies(pageToken, psid, text, replies) {
  return callSendAPI(pageToken, {
    recipient: { id: psid },
    messaging_type: 'RESPONSE',
    message: {
      text,
      quick_replies: replies.slice(0, 13).map(r => ({
        content_type: 'text',
        title: r.title.slice(0, 20), // FB limit
        payload: r.payload.slice(0, 1000),
      })),
    },
  });
}

export async function sendImage(pageToken, psid, imageUrl) {
  return callSendAPI(pageToken, {
    recipient: { id: psid },
    messaging_type: 'RESPONSE',
    message: {
      attachment: {
        type: 'image',
        payload: { url: imageUrl, is_reusable: false },
      },
    },
  });
}

export async function sendMultiImages(pageToken, psid, urls = []) {
  for (const u of urls) {
    if (u) await sendImage(pageToken, psid, u);
  }
}

export async function sendButtons(pageToken, psid, text, buttons) {
  return callSendAPI(pageToken, {
    recipient: { id: psid },
    messaging_type: 'RESPONSE',
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text,
          buttons: buttons.slice(0, 3).map(b => ({
            type: 'postback',
            title: b.title.slice(0, 20),
            payload: b.payload.slice(0, 1000),
          })),
        },
      },
    },
  });
}
