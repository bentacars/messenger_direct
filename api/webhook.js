// api/webhook.js
export const config = { runtime: "nodejs" };

import { getSession, setSession } from "../server/lib/session.js";
import { sendTypingOn, sendTypingOff, sendMessage } from "../server/lib/messenger.js";
import { route } from "../server/flows/router.js";
import { handleInterrupts } from "../server/lib/interrupts.js";
import { checkNudge, resetNudge } from "../server/lib/nudges.js";

const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || "";

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

        // Collect attachments (e.g. images, files)
        const attachments = evt.message?.attachments || [];

        // Load session
        let session = await getSession(psid);

        await sendTypingOn(psid);
        await resetNudge(session);

        // ---- INTERRUPTS (FAQ, off-topic, objections) ----
        if (text) {
          const intr = await handleInterrupts(text, session);
          if (intr) {
            await sendMessage(psid, intr.reply);
            if (intr.resume) await sendMessage(psid, intr.resume);
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

        // Send all replies (convert plain string to text message if needed)
        for (const r of replies) {
          if (typeof r === "string") {
            await sendMessage(psid, { text: r });
          } else {
            await sendMessage(psid, r);
          }
        }

        // Nudges (optional follow-up prompts if user stops replying)
        await checkNudge(newState, (t) => sendMessage(psid, t));

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
