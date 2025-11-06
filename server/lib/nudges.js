// server/lib/nudges.js
// Auto follow-up nudges for idle users
// Runs every 15 minutes (router calls checkNudge on each webhook event)

const ATTEMPT_LIMIT = 8;             // Max nudges per phase
const NUDGE_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const QUIET_HOURS = { start: 21, end: 9 }; // 9PM - 9AM PH time

function inQuietHours() {
  const now = new Date();
  const phHour = now.getUTCHours() + 8; // Asia/Manila = UTC+8
  const h = (phHour + 24) % 24;
  return h >= QUIET_HOURS.start || h < QUIET_HOURS.end;
}

export async function checkNudge(session, sendMessage) {
  const phase = session.phase || "phase1";
  const n = session.nudge || {};
  const now = Date.now();

  // Only Phase 1 & Phase 3 get nudges
  if (phase !== "phase1" && phase !== "cash" && phase !== "financing") return;

  const last = n.lastTs || 0;
  const count = n.count || 0;

  if (count >= ATTEMPT_LIMIT) return; // already max

  // Time since last nudge
  if (now - last < NUDGE_INTERVAL_MS) return;

  // Check quiet hours
  if (inQuietHours()) return;

  // Build message
  let text = "Still there? 🙂";
  if (phase === "phase1") {
    text = [
      "Sige, quick one lang — cash or financing ang plan mo?",
      "Location mo po? Para ma-match ko sa pinakamalapit.",
      "Auto or manual ang prefer mo? Pwede rin ‘any’ 🙂",
      "Magkano target budget mo? (SRP or cash-out)"
    ][count % 4];
  } else if (phase === "cash") {
    text = "Ready anytime if you wanna schedule viewing. 🙂";
  } else if (phase === "financing") {
    text = "Send mo lang kahit ID muna para ma-start ko pre-approval. 👍";
  }

  // Final attempt
  if (count + 1 === ATTEMPT_LIMIT) {
    text = "Pause muna ako. Want to continue or stop here?";
  }

  await sendMessage(text);

  // Update session
  session.nudge = {
    lastTs: now,
    count: count + 1,
  };
}

export function resetNudge(session) {
  session.nudge = { lastTs: Date.now(), count: 0 };
}

export default { checkNudge, resetNudge };
