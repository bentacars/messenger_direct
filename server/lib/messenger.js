// server/lib/messenger.js
// LLM-first orchestrator for BentaCars Messenger
// Exposes: handleWebhook (named) + default export
// Works with: server/flows/{qualifier,offers,cash,financing}.js
// Uses: server/lib/{session,state,interrupts}.js
// Sends messages directly to FB Graph API via PAGE_ACCESS_TOKEN

import fetch from "node-fetch";

// ---- Graph API ----
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
if (!PAGE_ACCESS_TOKEN) {
  console.warn("[messenger] PAGE_ACCESS_TOKEN is missing");
}

async function fbSend(psid, message) {
  if (!psid || !message) return;
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  const body = { recipient: { id: psid }, message };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error("[fbSend] error", r.status, t);
  }
}

export async function sendText(psid, text) {
  return fbSend(psid, { text });
}

export async function sendButtons(psid, text, buttons = []) {
  return fbSend(psid, {
    attachment: {
      type: "template",
      payload: {
        template_type: "button",
        text,
        buttons: buttons.slice(0, 3),
      },
    },
  });
}

export async function sendTyping(psid, on = true) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  const body = { recipient: { id: psid }, sender_action: on ? "typing_on" : "typing_off" };
  try {
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    console.error("[typing] failed", e);
  }
}

// ---- Utilities ----
const now = () => Date.now();
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

function normText(s = "") {
  return (s || "").toString().trim();
}

function pickStep(mod) {
  // accept any export style
  return mod?.step || mod?.default || mod?.handle || null;
}

// ---- Lazy imports (avoid circulars) ----
async function modSession() {
  const m = await import("./session.js");
  return m;
}
async function modState() {
  const m = await import("./state.js");
  return m;
}
async function modInterrupts() {
  const m = await import("./interrupts.js");
  return m;
}
async function modFlows() {
  const [q, o, c, f] = await Promise.all([
    import("../flows/qualifier.js"),
    import("../flows/offers.js"),
    import("../flows/cash.js"),
    import("../flows/financing.js"),
  ]);
  return { q, o, c, f };
}

// ---- Welcome helpers ----
async function sendWelcomeFirstTime(psid) {
  await sendText(
    psid,
    "Hi! 👋 I’m your BentaCars consultant. Ako na bahala mag-match ng best unit para sa’yo—hindi mo na kailangang mag-scroll nang mag-scroll. Let’s find your car, fast."
  );
}

async function sendWelcomeBack(psid) {
  await sendButtons(psid, "Welcome back! 👋 Gusto mo bang ituloy kung saan tayo huli, or start over?", [
    { type: "postback", title: "Continue", payload: "CONTINUE" },
    { type: "postback", title: "Start over", payload: "START_OVER" },
  ]);
}

// ---- Phase router ----
async function runPhase({ phase, text, psid, ctx }) {
  const { q, o, c, f } = await modFlows();

  const map = {
    qualifier: pickStep(q),
    offers: pickStep(o),
    cash: pickStep(c),
    financing: pickStep(f),
  };

  const fn = map[phase];
  if (!fn || typeof fn !== "function") {
    console.error(`[router] missing step() for phase ${phase}`);
    return;
  }

  await fn({
    psid,
    text,
    ...ctx,
  });
}

// ---- Public entry (called by api/webhook.js) ----
/**
 * handleWebhook(psid, text, rawEvent?)
 * psid: Facebook PSID
 * text: user message text (already normalized by webhook)
 * rawEvent: full messaging event (for postbacks, attachments, etc.)
 */
export async function handleWebhook(psid, text, rawEvent = {}) {
  text = normText(text);
  if (!psid) return;

  const [{ getSession, setSession, clearSession, touchSession }, { getState, setState, resetState }] =
    await Promise.all([modSession(), modState()]);

  // Load / init session
  let session = (await getSession(psid)) || {
    psid,
    created_at: now(),
    updated_at: now(),
    phase: "qualifier",
    memory_until: now() + SEVEN_DAYS,
    data: {}, // qualifiers, picks, etc.
  };

  // Expire memory after 7 days
  const expired = now() > (session.memory_until || 0);
  if (expired) {
    session = { psid, created_at: now(), updated_at: now(), phase: "qualifier", memory_until: now() + SEVEN_DAYS, data: {} };
    await resetState?.(psid);
  }

  // Postbacks (Continue / Start over)
  const postbackPayload = rawEvent?.postback?.payload || "";
  if (postbackPayload === "START_OVER" || /^(start over|restart|reset)$/i.test(text)) {
    await resetState?.(psid);
    session.phase = "qualifier";
    session.data = {};
    session.updated_at = now();
    await setSession(psid, session);
    await sendText(psid, "Noted ✅ Let’s start fresh.");
  } else if (postbackPayload === "CONTINUE") {
    await sendText(psid, "Sige! Itutuloy natin kung saan tayo huli 😊");
  }

  // Welcome logic (first-time vs returning)
  const isFirstMessage = !session?.welcomed;
  const lastSeen = session?.updated_at || 0;
  const returningWithin7d = !isFirstMessage && now() - lastSeen < SEVEN_DAYS;

  if (isFirstMessage) {
    // first-time: greet then continue qualifier
    session.welcomed = true;
    await setSession(psid, session);
    await sendWelcomeFirstTime(psid);
  } else if (returningWithin7d && /^(hi|hello|start|start over|continue)$/i.test(text)) {
    // returning: offer continue/start
    await sendWelcomeBack(psid);
    // We still proceed with flow if they answer something meaningful.
  }

  // Interrupts/FAQ layer
  try {
    const { handleInterrupts } = await modInterrupts();
    if (typeof handleInterrupts === "function") {
      const handled = await handleInterrupts(psid, text, {
        sendText,
        sendButtons,
        sendTyping,
      });
      if (handled) {
        // After answering, do not lose the pending step.
        await touchSession?.(psid);
        return;
      }
    }
  } catch (e) {
    console.error("[interrupts] failed", e);
  }

  // Decide current phase from State + Session
  let phase = session.phase || "qualifier";
  const state = (await getState(psid)) || {};

  // If no user text (e.g., quick tap on 'Hello'), keep phase = qualifier
  // Phase transitions are managed inside flows; we only persist here
  const ctx = {
    state,
    setState: async (patch) => {
      const next = { ...(await getState(psid)), ...(patch || {}) };
      await setState(psid, next);
      return next;
    },
    getState: () => getState(psid),
    session,
    setSession: async (patch) => {
      session = { ...(session || {}), ...(patch || {}) };
      await setSession(psid, session);
      return session;
    },
    setPhase: async (nextPhase) => {
      if (nextPhase && nextPhase !== session.phase) {
        session.phase = nextPhase;
        session.updated_at = now();
        await setSession(psid, session);
      }
    },
    sendText,
    sendButtons,
    sendTyping,
  };

  try {
    await sendTyping(psid, true);
    await runPhase({ phase, text, psid, ctx });
  } catch (err) {
    console.error("[handleWebhook] phase error:", err);
    // Fail-safe: never dead-end the thread
    await sendText(psid, "Oops—nagka-issue saglit. Tuloy natin! 😊");
  } finally {
    await sendTyping(psid, false);
    // Update session timestamp
    session.updated_at = now();
    await setSession(psid, session);
  }
}

// Default export (optional convenience)
export default { handleWebhook, sendText, sendButtons, sendTyping };
