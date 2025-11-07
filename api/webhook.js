// api/webhook.js
export const config = { runtime: "nodejs" };

import { getSession, setSession } from "../server/lib/session.js";
import { sendTypingOn, sendTypingOff, sendMessage } from "../server/lib/messenger.js";
import * as RouterNS from "../server/flows/router.js";
import { handleInterrupts } from "../server/lib/interrupts.js";
import { checkNudge, resetNudge } from "../server/lib/nudges.js";

const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || "";

/** Resolve router function regardless of CJS/ESM shape */
const router =
  RouterNS.router ||
  (RouterNS.default && (RouterNS.default.router || RouterNS.default)) ||
  RouterNS.route;

/**
 * Normalize our internal reply objects → valid Facebook Send API payload.
 * Accepts:
 *  - string
 *  - {type:"text", text}
 *  - {type:"buttons", text, buttons:[{title, payload}|{title, url|type:"web_url"}]}
 *  - {type:"carousel", elements:[...]}
 *  - {type:"image", url}
 *  - OR already-FB-shaped: {text} or {attachment}
 */
function toFbMessage(r) {
  // 1) Plain string
  if (typeof r === "string") return { text: r };

  // 2) Already FB-shaped (BUT only if there's NO internal "type")
  if (r && !r.type && (r.text || r.attachment)) return r;

  // 3) Our normalized shapes
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

  // 4) Safe fallback
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

        const text =
          evt.message?.text ||
          evt.postback?.title ||
          evt.postback?.payload ||
          "";

        // inside the for (const evt of entry.messaging || []) loop, right after you compute psid:

// Ignore delivery/read/standby events & echoes
if (evt.message?.is_echo) continue;
if (evt.delivery || evt.read || evt.standby) continue;

// De-dup by message id (Meta can retry)
const mid = evt.message?.mid || evt.postback?.mid || null;
let session = await getSession(psid);
session.processed_mids = Array.isArray(session.processed_mids) ? session.processed_mids : [];
if (mid && session.processed_mids.includes(mid)) {
  continue; // already handled
}
// keep a small rolling window of last 20 mids
if (mid) {
  session.processed_mids.push(mid);
  if (session.processed_mids.length > 20) session.processed_mids.shift();
}
        
        const attachments = evt.message?.attachments || [];
        let session = await getSession(psid);

        await sendTypingOn(psid);
        await resetNudge(session);

        // ---- INTERRUPTS (FAQ, objections, small talk) ----
        if (text) {
          const intr = await handleInterrupts(text, session);
          if (intr) {
            await sendMessage(psid, toFbMessage(intr.reply));
            if (intr.resume) await sendMessage(psid, toFbMessage(intr.resume));
            await setSession(psid, session);
            await sendTypingOff(psid);
            continue;
          }
        }

        // ---- MAIN ROUTER (LLM flow) ----
        if (typeof router !== "function") {
          console.error("Router not resolved to a function. Got:", router);
          await sendTypingOff(psid);
          continue;
        }

        const { replies = [], newState } = await router({
          psid,
          text,
          attachments,
          state: session,
        });

        // Send all replies via our formatter
        for (const r of replies) {
          await sendMessage(psid, toFbMessage(r));
        }

        // Optional nudge scheduling
        await checkNudge(newState, (t) => sendMessage(psid, toFbMessage(t)));

        // Persist session
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
