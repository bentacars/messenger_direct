// server/lib/messenger.js
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const FB_SEND = "https://graph.facebook.com/v19.0/me/messages";

async function fbPost(body) {
  const res = await fetch(`${FB_SEND}?access_token=${PAGE_ACCESS_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const txt = await res.text();
  if (!res.ok) console.error("Send API error:", res.status, txt);
  return txt;
}

export async function sendTyping(psid, on = true) {
  return fbPost({ recipient: { id: psid }, sender_action: on ? "typing_on" : "typing_off" });
}

export async function sendText(psid, text, quickReplies = null) {
  const message = { text };
  if (Array.isArray(quickReplies) && quickReplies.length) {
    message.quick_replies = quickReplies.map(q => ({
      content_type: "text",
      title: q.title,
      payload: q.payload
    }));
  }
  return fbPost({ recipient: { id: psid }, messaging_type: "RESPONSE", message });
}

export async function sendButtons(psid, text, buttons) {
  return fbPost({
    recipient: { id: psid },
    messaging_type: "RESPONSE",
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text,
          buttons: buttons.map(b => ({ type: "postback", title: b.title, payload: b.payload }))
        }
      }
    }
  });
}

export async function sendImage(psid, url) {
  return fbPost({
    recipient: { id: psid },
    message: {
      attachment: {
        type: "image",
        payload: { url, is_reusable: false }
      }
    }
  });
}

export async function sendCarousel(psid, cards) {
  // cards: [{title, subtitle, image_url, buttons: [{title,payload}] }]
  return fbPost({
    recipient: { id: psid },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: cards.map(c => ({
            title: c.title || "",
            subtitle: c.subtitle || "",
            image_url: c.image_url,
            buttons: (c.buttons || []).map(b => ({ type: "postback", title: b.title, payload: b.payload }))
          }))
        }
      }
    }
  });
}

export async function sendMessages(psid, arr = []) {
  // Simple sequential sender that understands the "type" contract used in router
  for (const m of arr) {
    if (m.type === "typing") await sendTyping(psid, m.on);
    else if (m.type === "text") await sendText(psid, m.text);
    else if (m.type === "buttons") await sendButtons(psid, m.text, m.buttons || []);
    else if (m.type === "image") await sendImage(psid, m.url);
    else if (m.type === "carousel") await sendCarousel(psid, m.cards || []);
  }
}
