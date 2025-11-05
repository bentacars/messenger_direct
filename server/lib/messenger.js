// server/lib/messenger.js
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

async function fbSend(psid, payload) {
  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ recipient: { id: psid }, message: payload }),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error('FB send error', res.status, t);
  }
}

export async function sendTypingOn(psid) {
  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ recipient: { id: psid }, sender_action: 'typing_on' }),
  });
}
export async function sendTypingOff(psid) {
  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ recipient: { id: psid }, sender_action: 'typing_off' }),
  });
}

export async function sendText(psid, text) { return fbSend(psid, { text }); }

export async function sendQuick(psid, text, buttons) {
  const quick_replies = buttons.map(b => ({
    content_type: 'text',
    title: b.title.slice(0,20),
    payload: b.payload || b.title.toLowerCase()
  }));
  return fbSend(psid, { text, quick_replies });
}

export async function sendImage(psid, url) {
  return fbSend(psid, { attachment: { type: 'image', payload: { url, is_reusable: false } } });
}

// Generic Template carousel (if supported)
export async function sendCarousel(psid, items) {
  return fbSend(psid, {
    attachment: {
      type: 'template',
      payload: {
        template_type: 'generic',
        elements: items.slice(0,10).map(x => ({
          title: x.title?.slice(0,80) || 'Photo',
          image_url: x.image_url,
          subtitle: x.subtitle?.slice(0,80) || '',
          buttons: x.buttons || []
        }))
      }
    }
  });
}
