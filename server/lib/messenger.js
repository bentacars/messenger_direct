// /server/lib/messenger.js
// Facebook Send API helpers + typing + optional profile lookup

const GRAPH = "https://graph.facebook.com/v19.0";
const PAGE_ACCESS_TOKEN =
  process.env.PAGE_ACCESS_TOKEN ||
  process.env.FB_PAGE_TOKEN ||
  process.env.PAGE_TOKEN ||
  "";

function fetchJSON(url, opts = {}) {
  return fetch(url, opts).then(async r => {
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    if (!r.ok) {
      console.error("Send API error:", r.status, text);
      throw new Error(text || `HTTP ${r.status}`);
    }
    return json ?? {};
  });
}

export async function sendTypingOn(psid) {
  if (!PAGE_ACCESS_TOKEN) return;
  const url = `${GRAPH}/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: psid }, sender_action: "typing_on" })
  }).catch(() => {});
}

export async function sendTypingOff(psid) {
  if (!PAGE_ACCESS_TOKEN) return;
  const url = `${GRAPH}/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: psid }, sender_action: "typing_off" })
  }).catch(() => {});
}

async function sendPayload(psid, message) {
  if (!PAGE_ACCESS_TOKEN) throw new Error("PAGE_ACCESS_TOKEN missing");
  const url = `${GRAPH}/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  return fetchJSON(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: psid }, message })
  });
}

// High-level senders

export async function sendText(psid, text) {
  return sendPayload(psid, { text });
}

export async function sendImage(psid, url) {
  return sendPayload(psid, { attachment: { type: "image", payload: { url, is_reusable: true } }});
}

export async function sendButtons(psid, text, buttons = []) {
  const elems = buttons.map(b => ({
    type: "postback",
    title: b.title,
    payload: b.payload
  }));
  return sendPayload(psid, {
    attachment: {
      type: "template",
      payload: {
        template_type: "button",
        text,
        buttons: elems
      }
    }
  });
}

export async function sendCarousel(psid, elements = []) {
  // elements: [{title, image_url, subtitle, default_action?}]
  return sendPayload(psid, {
    attachment: {
      type: "template",
      payload: {
        template_type: "generic",
        elements
      }
    }
  });
}

export async function sendMessages(psid, messages = []) {
  for (const m of messages) {
    if (!m) continue;
    if (m.type === "text") await sendText(psid, m.text);
    else if (m.type === "image") await sendImage(psid, m.url);
    else if (m.type === "buttons") await sendButtons(psid, m.text, m.buttons || []);
    else if (m.type === "carousel") await sendCarousel(psid, m.elements || []);
    else {
      // unknown → try as text
      if (m.text) await sendText(psid, m.text);
    }
  }
}

export async function getFirstName(psid) {
  try {
    if (!PAGE_ACCESS_TOKEN) return "";
    const url = `${GRAPH}/${psid}?fields=first_name&access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
    const r = await fetch(url);
    if (!r.ok) {
      const t = await r.text();
      console.warn("Profile API warn:", t);
      return "";
    }
    const j = await r.json();
    return j?.first_name ? String(j.first_name) : "";
  } catch {
    return "";
  }
}

export default {
  sendTypingOn, sendTypingOff, sendMessages, sendText, sendImage, sendButtons, sendCarousel, getFirstName
};
