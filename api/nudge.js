// api/nudge.js
// Call this via Vercel Cron every 5-10 minutes.
// Applies Phase 1/3 idle follow-ups and Financing docs follow-ups.

import { listAllSessionPids, getSession, saveSession } from '../server/lib/session.js';
import { sendText } from '../server/lib/messenger.js';
import {
  PH_TZ, NUDGE_INTERVAL_MIN, NUDGE_MAX_ATTEMPTS,
  QUIET_END_HOUR, QUIET_START_HOUR,
  DOCS_FOLLOW_INTERVAL_HOURS, DOCS_FOLLOW_MAX_HOURS
} from '../server/constants.js';

export const config = { runtime: 'nodejs' };

function phNow() { return new Date(new Date().toLocaleString('en-US', { timeZone: PH_TZ })); }
function inQuietHours(d=phNow()) {
  const h = d.getHours();
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
}

export default async function handler(_req, res) {
  const now = phNow().getTime();

  const pids = await listAllSessionPids();
  for (const psid of pids) {
    const s = await getSession(psid);
    if (!s) continue;

    // Idle nudge for Phase 1 & Phase 3 (cash)
    if (!inQuietHours()) {
      const last = s.lastInteractionAt || now;
      const mins = Math.floor((now - last)/60000);
      if (mins >= NUDGE_INTERVAL_MIN && (s.nudgeLevel||0) < NUDGE_MAX_ATTEMPTS) {
        // send gentle nudge based on phase
        const line =
          s.funnel?.agent === 'qualifier' ? 'Quick one lang — para ma-finalize ko, AT or manual prefer mo? (Pwede rin ANY)' :
          s.funnel?.agent === 'offers' ? 'Nandiyan ka pa? May 2 pang options na pwede ko i-send.' :
          s.phase === 'cash' ? 'Schedule natin viewing mo? Message mo lang yung day & time.' :
          s.phase === 'financing' ? 'Pwede mo nang i-send kahit ID muna para ma-pre screen natin.' :
          'Gusto mo ituloy natin?';
        await sendText(psid, line);
        s.nudgeLevel = (s.nudgeLevel||0)+1;
        s.lastInteractionAt = now; // optional: only bump if you want spacing per attempt
        await saveSession(psid, s);
      }
    }

    // Financing docs follow-ups
    if (s.docsFollowStartAt) {
      const elapsedH = Math.floor((now - s.docsFollowStartAt)/3600000);
      if (!inQuietHours() && elapsedH > 0 && (elapsedH % DOCS_FOLLOW_INTERVAL_HOURS === 0) && elapsedH <= DOCS_FOLLOW_MAX_HOURS) {
        const msg = elapsedH >= DOCS_FOLLOW_MAX_HOURS
          ? 'Di ko na muna i-follow up, but you can continue anytime. Want to proceed or stop here?'
          : 'Hi again! Ready anytime if you want to send your ID/payslip/COE so we can pre-approve habang naka-book na viewing mo. 👍';
        await sendText(psid, msg);
      }
    }
  }

  return res.status(200).json({ ok:true, checked:pids.length });
}
