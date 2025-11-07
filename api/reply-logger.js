// api/reply-logger.js
// Advanced webhook logger for Meta Messenger (ESM, Vercel)
// - Logs full inbound payloads (safely summarized), flags, PSID/MID
// - Shows whether event is echo / delivery / read / standby
// - Checks your session object (keys only)
// - Sends a unique "pong" reply and logs Send API result + timing
// - Add ?no_reply=1 to disable replying (logs only)

export const config = { runtime: "nodejs" };

import { sendMessage, sendTypingOn, sendTypingOff } from "../server/lib/messenger.js";
import { getSession, setSession } from "../server/lib/session.js";

const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || "";

// Safe JSON stringify helper (avoids throwing on circular)
function j(x) {
  try { return JSON.stringify(x, null, 2); } catch { return String(x); }
}

// Trim huge attachments array for readable logs
function summarizeEvent(evt) {
  const sum = {
    sender: evt.sender?.id,
    recipient: evt.recipient?.id,
    timestamp: evt.timestamp,
    message_text: evt.message?.text,
    postback_title: evt.postback?.title,
    postback_payload: evt.postback?.payload,
    mid: evt.message?.mid || evt.postback?.mid || null,
    flags: {
      is_echo: !!evt.message?.is_echo,
      has_delivery: !!evt.delivery,
      has_read: !!evt.read,
      has_standby: !!evt.standby,
      has_attachments: Array.isArray(evt.message?.attachments) ? evt.message.attachments.length : 0,
    },
  };
  return sum;
}

export default async function handler(req, res) {
  try {
    // --- Webhook verification (optional: handy if you register this as a callback)
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

    const noReply = req.query.no_reply === "1" || req.query.no_reply === "true";
    const body = req.body || {};

    console.log("🛰️  [reply-logger] RAW BODY START");
    console.log(j(body));
    console.log("🛰️  [reply-logger] RAW BODY END");

    if (body.object !== "page") {
      return res.status(200).json({ ok: true, note: "not a page event" });
    }

    for (const entry of body.entry || []) {
      for (const evt of entry.messaging || []) {
        const summary = summarizeEvent(evt);
        console.log("🔎 [reply-logger] EVENT:", j(summary));

        const psid = summary.sender;
        if (!psid) {
          console.log("⚠️  [reply-logger] No PSID on event; skipping");
          continue;
        }

        // Basic filters for noise
        if (summary.flags.is_echo) {
          console.log("ℹ️  [reply-logger] Skipping echo (another app or our own echo).");
          continue;
        }
        if (summary.flags.has_delivery || summary.flags.has_read || summary.flags.has_standby) {
          console.log("ℹ️  [reply-logger] Skipping delivery/read/standby signal.");
          continue;
        }

        // Session peek
        let session = await getSession(psid);
        console.log("📦 [reply-logger] Session keys:", Object.keys(session || {}));

        // De-dup by MID (Meta can retry)
        const mid = summary.mid;
        session.processed_mids = Array.isArray(session.processed_mids) ? session.processed_mids : [];
        if (mid && session.processed_mids.includes(mid)) {
          console.log("⏭️  [reply-logger] Duplicate MID; skipping:", mid);
          continue;
        }
        if (mid) {
          session.processed_mids.push(mid);
          if (session.processed_mids.length > 20) session.processed_mids.shift();
        }

        await sendTypingOn(psid);

        if (!noReply) {
          const t0 = Date.now();
          const tag = Math.random().toString(36).slice(2, 8);
          const text = `🔔 reply-logger pong (${tag})\n` +
                       `• mid: ${mid || "none"}\n` +
                       `• ts: ${summary.timestamp || "n/a"}`;
          try {
            await sendMessage(psid, { text });
            const dt = Date.now() - t0;
            console.log(`✅ [reply-logger] Sent pong in ${dt}ms (${tag})`);
          } catch (err) {
            console.error("❌ [reply-logger] Send API failed:", err?.message || err);
          }
        } else {
          console.log("🧪 [reply-logger] no_reply=1 → not sending any message.");
        }

        await setSession(psid, session);
        await sendTypingOff(psid);
      }
    }

    return res.status(200).json({ ok: true, logger: "done", replied: !noReply });
  } catch (err) {
    console.error("💥 [reply-logger] fatal:", err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}
