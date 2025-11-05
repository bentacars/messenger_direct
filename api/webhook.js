// api/webhook.js
export const config = { runtime: "nodejs" };

import route from "../server/flows/router.js";
import { sendText, sendTyping, sendMessages, sendButtons } from "../server/lib/messenger.js";
import { getSession, saveSession, clearSession } from "../server/lib/session.js";

const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || "verify-token";
const RESUME_COOLDOWN_MS = 60 * 1000; // don't spam resume card

export default async function handler(req, res) {
  // ----- Verify -----
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === FB_VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.status(403).send("Forbidden");
  }

  if (req.method !== "POST") return res.status(405).json({ ok: false });

  const body = req.body || {};
  if (!Array.isArray(body.entry)) return res.status(200).json({ ok: true });

  for (const entry of body.entry) {
    for (const evt of entry.messaging || []) {
      const psid = evt?.sender?.id;
      if (!psid) continue;

      // normalize
      const text = (
        (evt.message && evt.message.text) ||
        (evt.postback && evt.postback.title) ||
        ""
      ).trim();
      const payload = evt.postback?.payload || evt.message?.quick_reply?.payload || null;

      // update/seed session + reset idle counters
      let session = (await getSession(psid)) || { pid: psid, paused: false, nudgeLevel: 0, funnel: {} };
      session = await saveSession(psid, { lastInteractionAt: Date.now(), nudgeLevel: 0 });

      // STOP / PAUSE
      if (/^(stop|pause|quit|end)$/i.test(text) || payload === "STOP") {
        await saveSession(psid, { paused: true });
        await sendText(psid, "Alright, saved your details. Just message anytime to resume! 🙌");
        continue;
      }

      // RESUME buttons auto-offer if paused and no payload yet
      if (session.paused && !payload) {
        const tooSoon = session.offeredResumeAt && (Date.now() - session.offeredResumeAt) < RESUME_COOLDOWN_MS;
        if (!tooSoon) {
          await sendButtons(psid, "Welcome back! 😊 Itutuloy natin kung saan tayo huli, or start over?", [
            { title: "Continue", payload: "RESUME_CONTINUE" },
            { title: "Start over", payload: "RESUME_RESET" }
          ]);
          await saveSession(psid, { offeredResumeAt: Date.now() });
          continue;
        }
      }

      // Handle resume choices
      if (payload === "RESUME_CONTINUE") {
        await saveSession(psid, { paused: false, offeredResumeAt: 0 });
        await sendText(psid, "Great — itutuloy ko kung saan tayo huli. 👍");
      } else if (payload === "RESUME_RESET") {
        await clearSession(psid); // hard reset
        await sendText(psid, "All set — let’s start fresh! 🚗");
      }

      // If still paused, do not route
      const fresh = await getSession(psid);
      if (fresh?.paused) {
        await sendText(psid, "Paused tayo ngayon. Type **Resume** to continue.");
        continue;
      }

      try {
        await sendTyping(psid, true);
        const result = await route({ psid, text, payload, raw: evt });
        if (result?.messages?.length) await sendMessages(psid, result.messages);
      } catch (err) {
        console.error("route/send error", err);
        try { await sendText(psid, "Oops—nagka-issue saglit. Try uli in a bit? 🙏"); } catch {}
      } finally {
        await sendTyping(psid, false);
      }
    }
  }

  return res.status(200).json({ ok: true });
}
