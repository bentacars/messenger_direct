// api/lib/messenger.js
// Messenger helpers: text, quick replies, single image, and gallery carousel
const PAGE_TOKEN = process.env.FB_PAGE_TOKEN;

async function fbCall(body) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error('FB send error', res.status, t);
  }
}

// ----------- send primitives -----------
export async function sendText(senderId, text) {
  return fbCall({ recipient: { id: senderId }, message: { text } });
}

export async function sendQuickReplies(senderId, text, options = []) {
  const quick_replies = options.map(o => ({
    content_type: 'text',
    title: o.title,
    payload: o.payload,
  }));
  return fbCall({
    recipient: { id: senderId },
    message: { text, quick_replies },
  });
}

export async function sendImage(senderId, imageUrl) {
  return fbCall({
    recipient: { id: senderId },
    message: {
      attachment: {
        type: 'image',
        payload: { url: imageUrl, is_reusable: false },
      },
    },
  });
}

// ----------- gallery (carousel) -----------
export async function sendGallery(senderId, elements) {
  // elements = [{title, image_url, subtitle?, default_url?, buttons?}]
  const payload = {
    template_type: 'generic',
    image_aspect_ratio: 'square', // looks best for car photos; can be "horizontal"
    sharable: true,
    elements: elements.slice(0, 10), // Messenger limit per message
  };

  // map to Messenger element shape
  payload.elements = payload.elements.map(el => ({
    title: el.title?.slice(0, 80) || 'Photo',
    image_url: el.image_url,
    subtitle: el.subtitle?.slice(0, 80) || '',
    default_action: el.default_url
      ? { type: 'web_url', url: el.default_url }
      : undefined,
    buttons: el.buttons?.slice(0, 3),
  }));

  return fbCall({
    recipient: { id: senderId },
    message: { attachment: { type: 'template', payload } },
  });
}

// Helper to build a plain photo gallery from a list of URLs
export function buildImageElements(urls = []) {
  let total = urls.length;
  return urls.slice(0, 10).map((u, i) => ({
    title: `Photo ${i + 1} / ${total}`,
    image_url: u,
    default_url: u,
  }));
}

// ----------- restart / greetings detection -----------
export function isRestart(text = '') {
  const t = text.trim().toLowerCase();
  return [
    'restart','reset','start over','start','new','bagong chat','bagong usapan',
    'ulit','ulit tayo','umpisa','fresh start'
  ].some(k => t === k || t.startsWith(k));
}

export function isGreeting(text = '') {
  const t = text.trim().toLowerCase();
  return ['hi','hello','hey','kumusta','kamusta','good morning','good pm','good evening']
    .some(k => t === k || t.startsWith(k));
}
