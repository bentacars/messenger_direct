// Minimal FB Send API helpers + safe profile lookup

const PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN || process.env.FB_PAGE_TOKEN || "";

const FB_URL = "https://graph.facebook.com/v17.0/me/messages";
const PROFILE_URL = (psid) => `https://graph.facebook.com/v17.0/${psid}?fields=first_name,last_name&access_token=${encodeURIComponent(PAGE_TOKEN)}`;

async function fbFetch(url, body) {
  const res = await fetch(url + `?access_token=${encodeURIComponent(PAGE_TOKEN)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) {
    console.error("Send API error:", res.status, text);
  }
  return { ok: res.ok, status: res.status, body: text };
}

export async function sendTypingOn(psid) {
  if (!PAGE_TOKEN) return;
  await fbFetch(FB_URL, { recipient: { id: psid }, sender_action: "typing_on" });
}
export async function sendTypingOff(psid) {
  if (!PAGE_TOKEN) return;
  await fbFetch(FB_URL, { recipient: { id: psid }, sender_action: "typing_off" });
}

export async function sendText(psid, text) {
  if (!PAGE_TOKEN) return;
  return fbFetch(FB_URL, {
    recipient: { id: psid },
    messaging_type: "RESPONSE",
    message: { text }
  });
}

export async function sendButtons(psid, text, buttons = []) {
  if (!PAGE_TOKEN) return;
  const payloadButtons = buttons.map(b => ({
    type: "postback",
    title: b.title,
    payload: b.payload || b.title
  }));
  return fbFetch(FB_URL, {
    recipient: { id: psid },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text,
          buttons: payloadButtons
        }
      }
    }
  });
}

export async function sendImage(psid, url) {
  if (!PAGE_TOKEN || !url) return;
  return fbFetch(FB_URL, {
    recipient: { id: psid },
    message: {
      attachment: { type: "image", payload: { url, is_reusable: false } }
    }
  });
}

// Generic template carousel
export async function sendCarousel(psid, elements = []) {
  if (!PAGE_TOKEN || !elements.length) return;
  return fbFetch(FB_URL, {
    recipient: { id: psid },
    message: {
      attachment: {
        type: "template",
        payload: { template_type: "generic", elements }
      }
    }
  });
}

export async function getProfile(psid) {
  if (!PAGE_TOKEN) return null;
  try {
    const res = await fetch(PROFILE_URL(psid), { method: "GET" });
    if (!res.ok) {
      const t = await res.text();
      // Don’t crash on (#3) capability errors in dev
      console.warn("Profile API warn:", t);
      return null;
    }
    const j = await res.json();
    return j || null;
  } catch (e) {
    console.warn("Profile API error:", e?.message || e);
    return null;
  }
}
