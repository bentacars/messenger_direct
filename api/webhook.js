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
      return res.status(405).json({ ok: false });
    }

    const body = req.body || {};
    if (body.object !== "page") return res.status(200).json({ ok: true });

    for (const entry of body.entry || []) {
      for (const evt of entry.messaging || []) {
        const psid = evt.sender?.id;
        if (!psid) continue;

        const text = evt.message?.text || evt.postback?.payload || "";
        let session = await getSession(psid);

        await sendTypingOn(psid);
        resetNudge(session);

        // Interrupts (FAQ/objections)
        if (text) {
          const intr = await handleInterrupts(text, session);
          if (intr) {
            await sendMessage(psid, intr.reply);
            if (intr.resume) await sendMessage(psid, intr.resume);
            await setSession(psid, session);
            await sendTypingOff(psid);
            continue;
          }
        }

        // Main LLM flow
        const { messages, nextSession } = await route({ session, text, evt });
        for (const msg of messages) await sendMessage(psid, msg);

        await checkNudge(nextSession, (t) => sendMessage(psid, t));
        await setSession(psid, nextSession);
        await sendTypingOff(psid);
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("webhook fatal", err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}
