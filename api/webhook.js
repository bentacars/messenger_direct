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
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];
      if (mode === "subscribe" && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
      }
      return res.status(403).send("Forbidden");
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const body = req.body || {};
    if (body.object !== "page" || !Array.isArray(body.entry)) {
      return res.status(200).json({ ok: true });
    }

    for (const entry of body.entry) {
      for (const evt of entry.messaging || []) {
        const psid = evt.sender?.id;
        if (!psid) continue;

        const text =
          evt.message?.text ||
          evt.postback?.title ||
          "";
        const hasMsg = !!text;

        // Load session
        let session = await getSession(psid);

        // Always typing on
        await sendTypingOn(psid);

        // Reset nudges whenever user interacts
        resetNudge(session);

        // Check interrupts (FAQ / objection)
        if (hasMsg) {
          const intr = await handleInterrupts(text, session);
          if (intr) {
            await sendMessage(psid, intr.reply);
            if (intr.resume) await sendMessage(psid, intr.resume);
            await setSession(psid, session);
            await sendTypingOff(psid);
            continue;
          }
        }

        // Main flow
        const { messages, nextSession } = await route({ session, text, evt });
        for (const m of messages) {
          await sendMessage(psid, m);
        }
        session = nextSession;

        // Check nudges if idle
        await checkNudge(session, (t) => sendMessage(psid, t));

        // Save session
        await setSession(psid, session);

        await sendTypingOff(psid);
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("webhook error", err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}
