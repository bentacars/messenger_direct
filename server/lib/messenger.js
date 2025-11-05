// server/lib/messenger.js
const PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN;

async function call(path, body) {
  const url = `https://graph.facebook.com/v19.0/me/${path}?access_token=${PAGE_TOKEN}`;
  const rsp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!rsp.ok) {
    const t = await rsp.text();
    console.error('[FB API error]', t);
  }
}

export async function sendText(psid, text, quick = null) {
  const message = { text };
  if (quick && quick.length) {
    message.quick_replies = quick.map((title) => ({ content_type: 'text', title, payload: title }));
  }
  await call('messages', { recipient: { id: psid }, messaging_type: 'RESPONSE', message });
}

export async function sendButtons(psid, text, buttons = []) {
  const payload = {
    template_type: 'button',
    text,
    buttons: buttons.map((b) => ({ type: 'postback', title: b.title, payload: b.payload || b.title }))
  };
  await call('messages', {
    recipient: { id: psid },
    messaging_type: 'RESPONSE',
    message: { attachment: { type: 'template', payload } }
  });
}

export async function sendImages(psid, urls = []) {
  for (const u of urls) {
    await call('messages', {
      recipient: { id: psid },
      message: { attachment: { type: 'image', payload: { url: u, is_reusable: false } } }
    });
  }
}

export async function sendTypingOn(psid) { await call('messages', { recipient: { id: psid }, sender_action: 'typing_on' }); }
export async function sendTypingOff(psid) { await call('messages', { recipient: { id: psid }, sender_action: 'typing_off' }); }
