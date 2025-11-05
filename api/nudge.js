// api/nudge.js
export const config = { runtime: "nodejs" };

import { listAllSessionPids, getSession, saveSession } from "../server/lib/session.js";
import { sendText, sendButtons } from "../server/lib/messenger.js";

const MIN5 = 5 * 60 * 1000;
const HR2  = 2 * 60 * 60 * 1000;
const DAY1 = 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).json({ ok: false });

  const pids = await listAllSessionPids();
  const now  = Date.now();

  let total = 0, nudged = 0;
  for (const pid of pids) {
    total++;
    try {
      const s = await getSession(pid);
      if (!s) continue;
      if (s.paused) continue; // don't ping paused users

      const last = Number(s.lastInteractionAt || s.updatedAt || 0);
      if (!last) continue;

      const idle = now - last;
      const lvl  = Number(s.nudgeLevel || 0);

      // Level 0 → after 5 minutes
      if (idle >= MIN5 && lvl === 0) {
        await sendText(pid, "Hi! Nandito lang ako. Gusto mo bang ituloy ang car match?");
        await saveSession(pid, { nudgeLevel: 1 });
        nudged++; continue;
      }

      // Level 1 → after 2 hours
      if (idle >= HR2 && lvl === 1) {
        await sendText(pid, "Quick reminder 😊 Ready ka na bang mag-continue? I can pull fresh options for you.");
        await saveSession(pid, { nudgeLevel: 2 });
        nudged++; continue;
      }

      // Level 2 → after 24 hours → auto-pause + resume choices
      if (idle >= DAY1 && lvl === 2) {
        await saveSession(pid, { nudgeLevel: 3, paused: true });
        await sendButtons(pid, "Saved your progress. Ready to continue?", [
          { title: "Continue",  payload: "RESUME_CONTINUE" },
          { title: "Start over", payload: "RESUME_RESET" }
        ]);
        nudged++; continue;
      }
    } catch (e) {
      console.error("nudge error", pid, e);
    }
  }

  return res.status(200).json({ ok: true, total, nudged });
}
