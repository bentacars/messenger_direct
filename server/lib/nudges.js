// server/lib/nudges.js
// Auto follow-up nudges for idle users
// Called inside router via: checkNudge(newState, (t) => sendMessage(psid, toFbMessage(t)))

const ATTEMPT_LIMIT = 8;                       // Max nudges per user per phase
const NUDGE_INTERVAL_MS = 15 * 60 * 1000;      // 15 minutes
const QUIET_HOURS = { start: 21, end: 9 };     // 9PM–9AM (PH timezone)

/** Quiet-hours checker (UTC+8 Manila time) */
function inQuietHours() {
  const now = new Date();
  const phHour = (now.getUTCHours() + 8 + 24) % 24; // convert to PH time safely
  return phHour >= QUIET_HOURS.start || phHour < QUIET_HOURS.end;
}

/**
 * checkNudge(state, send)
 *   - state: session object (mutated here)
 *   - send:  async (text) => void  (router already wraps toFbMessage + sendMessage)
 */
export async function checkNudge(state = {}, send) {
  const phase = state.phase || "qualifying";
  const n = state.nudge || {};
  const now = Date.now();

  // Only nudge in these phases
  if (phase !== "qualifying" && phase !== "cash" && phase !== "financing") return;

  const last = n.lastTs || 0;
  const count = n.count || 0;

  if (count >= ATTEMPT_LIMIT) return;              // cap reached
  if (now - last < NUDGE_INTERVAL_MS) return;      // too soon
  if (inQuietHours()) return;                      // respect quiet hours

  // Build the message
  let text = "Still there? 🙂";

  if (phase === "qualifying") {
    const prompts = [
      "Cash or financing ang plan mo?",
      "Location mo po? Para ma-match ko sa pinakamalapit.",
      "Auto or manual prefer mo? Pwede rin ‘any’.",
      "Magkano comfortable na budget mo? (SRP or cash-out)",
    ];
    text = prompts[count % prompts.length];
  } else if (phase === "cash") {
    text = "Pwede tayong mag-schedule ng viewing anytime. Let me know. 🙂";
  } else if (phase === "financing") {
    text = "Kahit valid ID muna, ma-start ko na agad ang pre-approval. 👍";
  }

  // Final attempt wording
  if (count + 1 === ATTEMPT_LIMIT) {
    text = "Last ping ko muna. Gusto mo ba ituloy o stop na tayo dito?";
  }

  if (typeof send === "function") {
    await send(text);
  }

  // save updated counters
  state.nudge = {
    lastTs: now,
    count: count + 1,
  };
}

/** Reset on ANY incoming user message to avoid spam nudges */
export function resetNudge(state = {}) {
  state.nudge = { lastTs: Date.now(), count: 0 };
}

/** Default export so both `import {checkNudge}` + `import nudges from '...'` work */
export default { checkNudge, resetNudge };
