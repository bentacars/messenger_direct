// api/webhook.js
export const config = { runtime: "nodejs" };

import { getSession, setSession } from "../server/lib/session.js";
import { sendTypingOn, sendTypingOff, sendMessage } from "../server/lib/messenger.js";
import { route } from "../server/flows/router.js";
import { handleInterrupts } from "../server/lib/interrupts.js";
import { checkNudge, resetNudge } from "../server/lib/nudges.js";

const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || "";

/**
 * Map our internal reply objects → Facebook Send API payload.
 * Supports: string, {type:"text"}, {type:"buttons"}, {type:"carousel"}, {type:"image"},
 * or already-FB-shaped objects containing {text} or {attachment}.
 */
function toFbMessage(r) {
  // Plain string
  if (typeof r === "string") return { text: r };

  // Already a valid FB payload
  if (r && (r.text || r.attachment)) return r;

  // Structured types we use
  if (r?.type === "text") {
    return { text: r.text || "" };
  }

  if (r?.type === "buttons") {
    const buttons = (r.buttons || []).map((b) => {
      if (b.type === "web_url" || b.type === "url") {
        return { type: "web_url", title: b.title, url: b.url };
      }
      // default to postback
      return { type: "postback", title: b.title, payload: b.payload || b.title || "BTN_CLICK" };
    });

    return {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: r.text || "Please choose:",
          buttons,
        },
      },
    };
  }

  if (r?.type === "carousel") {
    return {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: r.elements || [],
        },
      },
    };
  }

  if (r?.type === "image") {
    return {
      attachment: {
        type: "image",
        payload: { url: r.url, is_reusable: true },
      },
    };
  }

  // Fallback
  return { text: r?.text || "✅" };
}

export default async function handler(req, res) {
  try {
    // ---- VERIFY WEBHOOK ----
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];
      if (mode === "subscribe" && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
      }
      return res.status(403).send("Forbidden");
    }

    // ---- MUST BE POST FOR NORMAL FLOW ----
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const body = req.body || {};
    if (body.object !== "page") return res.status(200).json({ ok: true });

    for (const entry of body.entry || []) {
      for (const evt of entry.messaging || []) {
        const psid = evt.sender?.id;
        if (!psid) continue;

        // Normalized text from user (message, postback title, fallback payload)
        const text =
          evt.message?.text ||
          evt.postback?.title ||
          evt.postback?.payload ||
          "";

        // Collect attachments (e.g., images, files)
        const attachments = evt.message?.attachments || [];

        // Load session
        let session = await getSession(psid);

        await sendTypingOn(psid);
        resetNudge(session);

        // ---- INTERRUPTS (FAQ, off-topic, objections) ----
        if (text) {
          const intr = await handleInterrupts(text, session);
          if (intr) {
            await sendMessage(psid, toFbMessage(intr.reply));
            if (intr.resume) await sendMessage(psid, toFbMessage(intr.resume));
            await setSession(psid, session);
            await sendTypingOff(psid);
            continue; // Stop here — do not move to normal flow
          }
        }

        // ---- MAIN ROUTER (LLM flow) ----
        const { replies = [], newState } = await route({
          psid,
          text,
          attachments,
          state: session,
        });

        // Send all replies (convert to FB message if needed)
        for (const r of replies) {
          await sendMessage(psid, toFbMessage(r));
        }

        // Nudges (optional follow-up prompts if user stops replying)
        await checkNudge(newState, (t) => sendMessage(psid, toFbMessage(t)));

        // Save session
        await setSession(psid, newState);

        await sendTypingOff(psid);
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("webhook fatal", err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}
