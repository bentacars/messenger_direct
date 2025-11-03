// api/lib/messenger.js
const FB_TOKEN = process.env.FB_PAGE_TOKEN;
const FB_API = 'https://graph.facebook.com/v18.0/me/messages';

async function fbSend(payload) {
  const resp = await fetch(`${FB_API}?access_token=${encodeURIComponent(FB_TOKEN)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.error('FB send error', resp.status, text);
    return false;
  }
  return true;
}

export async function sendTypingOn(id)  { return fbSend({ recipient:{ id }, sender_action:'typing_on'  }); }
export async function sendTypingOff(id) { return fbSend({ recipient:{ id }, sender_action:'typing_off' }); }

export async function sendText(id, text) {
  return fbSend({ recipient:{ id }, message:{ text } });
}

export async function sendImage(id, url) {
  return fbSend({
    recipient:{ id },
    message:{
      attachment:{
        type: 'image',
        payload: { url, is_reusable: false }
      }
    }
  });
}

export async function sendQuickReplies(id, text, replies) {
  const qr = (replies || []).map(r => ({
    content_type: 'text',
    title: (r.title || '').slice(0, 20),
    payload: r.payload || r.title || 'CHOOSE',
  }));
  return fbSend({ recipient:{ id }, message:{ text, quick_replies: qr } });
}

/**
 * Send a Generic Template (carousel/gallery).
 * Returns true if Facebook accepts, false if it rejects (so caller can fallback).
 */
export async function sendGenericTemplate(id, elements) {
  if (!elements || !elements.length) return false;
  const payload = {
    recipient:{ id },
    message:{
      attachment:{
        type: 'template',
        payload:{
          template_type: 'generic',
          elements: elements.slice(0, 10).map(el => ({
            title: (el.title || 'Vehicle').slice(0, 80),
            subtitle: (el.subtitle || '').slice(0, 80),
            image_url: el.image_url || undefined,
            buttons: (el.buttons || []).slice(0, 3),
          })),
        }
      }
    }
  };
  return fbSend(payload);
}
