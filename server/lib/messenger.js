// server/lib/messenger.js
// FB Send API + Button/Carousel helpers

import fetch from "node-fetch";
import { FB_GRAPH_API, FB_PAGE_TOKEN } from "./constants.js";

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
      payload: {
        template_type: "generic",
        elements,
      },
    },
  });
}

async function callSendAPI(body) {
  try {
    const url = `${FB_GRAPH_API}/me/messages?access_token=${FB_PAGE_TOKEN}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) {
      console.error("Send API error:", json);
      throw new Error(JSON.stringify(json));
    }
    return json;
  } catch (err) {
    console.error("Send API fatal error:", err);
    return null;
  }
}
