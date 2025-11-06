// server/lib/messenger.js
import fetch from "node-fetch";
import { PAGE_ACCESS_TOKEN } from "./constants.js";

const GRAPH = "https://graph.facebook.com/v17.0";

// ✅ NEW sendMessage() — maps our internal message format to valid FB payload
export async function sendMessage(psid, payload) {
  // Allow raw string
  if (typeof payload === "string") {
    return callSendAPI({
      messaging_type: "RESPONSE",
      recipient: { id: psid },
      message: { text: payload }
    });
  }

  // Text message
  if (payload?.type === "text" || payload?.text) {
    return callSendAPI({
      messaging_type: "RESPONSE",
      recipient: { id: psid },
      message: { text: payload.text }
    });
  }

  // Button template
  if (payload?.type === "buttons" && payload.text && Array.isArray(payload.buttons)) {
    const buttons = payload.buttons.map(b =>
      b.type === "web_url"
        ? { type: "web_url", title: b.title, url: b.url }
        : { type: "postback", title: b.title, payload: b.payload || b.title }
    );

    return callSendAPI({
      messaging_type: "RESPONSE",
      recipient: { id: psid },
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "button",
            text: payload.text,
            buttons
          }
        }
      }
    });
  }

  // Image message
  if (payload?.type === "image" && payload.url) {
    return callSendAPI({
      messaging_type: "RESPONSE",
      recipient: { id: psid },
      message: {
        attachment: {
          type: "image",
          payload: { url: payload.url, is_reusable: true }
        }
      }
    });
  }

  // Fallback
  return callSendAPI({
    messaging_type: "RESPONSE",
    recipient: { id: psid },
    message: { text: payload?.text || "✅" }
  });
}


export async function sendTypingOn(psid) {
  return callSendAPI({ recipient: { id: psid }, sender_action: "typing_on" });
}
export async function sendTypingOff(psid) {
  return callSendAPI({ recipient: { id: psid }, sender_action: "typing_off" });
}

export async function sendCarousel(psid, elements) {
  return sendMessage(psid, {
    attachment: {
      type: "template",
      payload: { template_type: "generic", elements },
    },
  });
}

async function callSendAPI(body) {
  try {
    const url = `${GRAPH}/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) {
      console.error("Send API error:", json);
      return null;
    }
    return json;
  } catch (err) {
    console.error("Send API fatal error:", err);
    return null;
  }
}
