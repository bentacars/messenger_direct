import fetch from 'node-fetch';

const FB_URL = 'https://graph.facebook.com/v18.0/me/messages';

export async function sendText(psid, text) {
  const r = await fetch(`${FB_URL}?access_token=${process.env.FB_PAGE_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_type: 'RESPONSE', recipient: { id: psid }, message: { text } })
  });
  if (!r.ok) console.error('sendText error', r.status, await r.text());
}

export async function sendQuickReplies(psid, text, replies) {
  const body = {
    messaging_type: 'RESPONSE',
    recipient: { id: psid },
    message: {
      text,
      quick_replies: replies.map(t => ({ content_type: 'text', title: t, payload: t }))
    }
  };
  const r = await fetch(`${FB_URL}?access_token=${process.env.FB_PAGE_TOKEN}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!r.ok) console.error('quickReplies error', r.status, await r.text());
}

export async function sendImage(psid, imageUrl) {
  const body = {
    recipient: { id: psid },
    message: { attachment: { type: 'image', payload: { url: imageUrl, is_reusable: false } } }
  };
  const r = await fetch(`${FB_URL}?access_token=${process.env.FB_PAGE_TOKEN}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!r.ok) console.error('sendImage error', r.status, await r.text());
}
