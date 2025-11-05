// server/lib/messenger.js
import fetch from "node-fetch";
import { FB_PAGE_TOKEN } from "./constants.js";

const GRAPH = "https://graph.facebook.com/v17.0";

export async function sendMessage(psid, payload) {
  const body = {
    recipient: { id: psid },
    message: typeof payload === "string" ? { text: payload } : payload,
  };
  return callSendAPI(body);
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
    const url = `${GRAPH}/me/messages?access_token=${FB_PAGE_TOKEN}`;
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
