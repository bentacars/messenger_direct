// server/lib/nudges.js
// Auto follow-up nudges for idle users
// router calls checkNudge(newState, (t) => sendMessage(psid, toFbMessage(t)))

const ATTEMPT_LIMIT = 8;                  // Max nudges per phase
const NUDGE_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const QUIET_HOURS = { start: 21, end: 9 };// 9PM–9AM Asia/Manila

function inQuietHours() {
  const now = new Date();
  const phHour = (now.getUTCHours() + 8 + 24) % 24; // Asia/Manila = UTC+8
  return phHour >= QUIET_HOURS.start || phHour < QUIET_HOURS.end;
}

/**
 * checkNudge(state, send)
 * - state: your session object (mutated here to track nudge attempts)
 * - send:  (text) => Promise<void>  — webhook passes a wrapper that already formats to FB
 */
export async function checkNudge(state = {}, send) {
  const phase = state.phase || "qualifying";
  const n = state.nudge || {};
  const now = Date.now();

  // Only nudge during these phases
  if (phase !== "qualifying" && phase !== "cash" && phase !== "financing") return;

  const last = n.lastTs || 0;
  const count = n.count || 0;

  if (count >= ATTEMPT_LIMIT) return;              // reached the cap
  if (now - last < NUDGE_INTERVAL_MS) return;      // too soon
  if (inQuietHours()) return;                       // respect quiet hours

  // Compose message per phase
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
    text = "Pwede tayong mag-schedule ng viewing anytime. Sabihin mo lang. 🙂";
  } else if (phase === "financing") {
    text = "Kahit valid ID muna, ma-start ko na ang pre-approval. 👍";
  }

  if (count + 1 === ATTEMPT_LIMIT) {
    text = "Last ping ko muna. G gusto mong ituloy o stop na tayo dito?";
  }

  if (typeof send === "function") {
    await send(text);
  }

  // Persist counters
  state.nudge = { lastTs: now, count: count + 1 };
}

/** Reset nudge window whenever we receive a fresh user event */
export function resetNudge(state = {}) {
  state.nudge = { lastTs: Date.now(), count: 0 };
}
