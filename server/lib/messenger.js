// server/lib/messenger.js (ESM)
import { PAGE_ACCESS_TOKEN } from "./constants.js";

if (!PAGE_ACCESS_TOKEN) {
  console.warn("[messenger] PAGE_ACCESS_TOKEN is empty — Send API will fail.");
}

const FB_SEND_URL = `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(
  PAGE_ACCESS_TOKEN || ""
)}`;

// Low-level sender that accepts either {sender_action} or {message}
async function fbSend(psid, payload) {
  const body = {
    recipient: { id: psid },
    ...(payload.sender_action
      ? { sender_action: payload.sender_action }
      : { message: payload.message || payload }) // allow raw {text}/{attachment} or {message:{...}}
  };

  const res = await fetch(FB_SEND_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    // ignore parse errors
  }

  if (!res.ok || (json && json.error)) {
    console.error("Send API error:", json?.error || (await res.text?.()));
    throw new Error("FB Send failed");
  }
  return json;
}

// Accepts a plain string, {text}, {attachment}, or already-FB-shaped object
export async function sendMessage(psid, message) {
  const msg =
    typeof message === "string"
      ? { text: message }
      : message?.text || message?.attachment
      ? message
      : { text: "✅" };

  return fbSend(psid, { message: msg });
}

export async function sendTypingOn(psid) {
  return fbSend(psid, { sender_action: "typing_on" });
}

export async function sendTypingOff(psid) {
  return fbSend(psid, { sender_action: "typing_off" });
}

export default { sendMessage, sendTypingOn, sendTypingOff };
