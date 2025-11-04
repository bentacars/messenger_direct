// api/lib/messenger.js

const PAGE_TOKEN = process.env.FB_PAGE_TOKEN;
const FB_API = 'https://graph.facebook.com/v18.0/me/messages';

// --- utils ---
function isPsid(v) { return typeof v === 'string' && /^\d{6,}$/.test(v); }

function normalizePsidFirst(a, b) {
  // expected: (psid, payload/text)
  if (isPsid(a)) return [a, b];
  if (isPsid(b)) return [b, a]; // tolerate reversed args
  // last resort: throw with clear message
  throw new Error(`Invalid PSID: "${a}"`);
}

async function fbSend(payload) {
  const url = `${FB_API}?access_token=${encodeURIComponent(PAGE_TOKEN)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`FB send error ${res.status} ${t}`);
  }
}

// --- exports ---
export async function sendTypingOn(psid) {
  const [id] = normalizePsidFirst(psid, 'x');
  await fbSend({
    recipient: { id },
    sender_action: 'typing_on',
  });
}

export async function sendTypingOff(psid) {
  const [id] = normalizePsidFirst(psid, 'x');
  await fbSend({
    recipient: { id },
    sender_action: 'typing_off',
  });
}

export async function sendText(psid, text) {
  const [id, msg] = normalizePsidFirst(psid, text);
  await fbSend({
    recipient: { id },
    message: { text: String(msg).slice(0, 2000) }, // guard length
  });
}

export async function sendImage(psid, url) {
  const [id, u] = normalizePsidFirst(psid, url);
  await fbSend({
    recipient: { id },
    message: {
      attachment: {
        type: 'image',
        payload: { url: u, is_reusable: false },
      },
    },
  });
}
