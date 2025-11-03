// /api/lib/messenger.js
import fetch from 'node-fetch';

const PAGE_TOKEN = process.env.FB_PAGE_TOKEN;

export async function sendText(psid, text) {
  return callSendAPI({
    recipient: { id: psid },
    message: { text }
  });
}

export async function sendButtons(psid, text, buttons) {
  return callSendAPI({
    recipient: { id: psid },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text,
          buttons
        }
      }
    }
  });
}

export async function sendImage(psid, url) {
  return callSendAPI({
    recipient: { id: psid },
    message: {
      attachment: {
        type: "image",
        payload: { url }
      }
    }
  });
}

export async function sendImagesSequential(psid, urls) {
  for (const u of urls) {
    await sendImage(psid, u);
  }
}

async function callSendAPI(body) {
  const res = await fetch(`https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    console.error("Send API error:", res.status, msg);
  }
  return res.ok;
}
