// api/lib/nudges.js
import cfg from '../../config/followup.json' assert { type: 'json' };
import { sendText } from './messenger.js';

function nowPHDate() {
  return new Date().toLocaleString('en-US', { timeZone: cfg.phase1.tz || 'Asia/Manila' });
}
function isQuiet(tzConf) {
  const tz = tzConf.tz || 'Asia/Manila';
  const now = new Date();
  const hh = Number(now.toLocaleString('en-PH', { timeZone: tz, hour: '2-digit', hour12: false }));
  const [qsH] = (tzConf.quiet_start || '21:00').split(':').map(Number);
  const [qeH] = (tzConf.quiet_end || '09:00').split(':').map(Number);
  // quiet from qsH..23 and 0..qeH-1
  if (hh >= qsH) return true;
  if (hh < qeH) return true;
  return false;
}

const P1_LINES = [
  "Quick one lang: cash or financing ang plan mo?",
  "Saan location mo (city/province)?",
  "Auto or manual prefer mo? (pwede 'any')",
  "Anong body type hanap mo? (sedan/suv/mpv/van/pickup—or 'any')"
];

export async function maybeNudgePhase1(psid, session) {
  const conf = cfg.phase1;
  if (isQuiet(conf)) return;

  const last = session.nudges?.p1?.lastAt || 0;
  const count = session.nudges?.p1?.count || 0;
  const gapMs = (conf.interval_min || 15) * 60 * 1000;

  if (count >= (conf.max_attempts || 8)) return;

  const idleMs = Date.now() - (session.lastUserAt || 0);
  if (idleMs < gapMs) return;

  // choose next line round-robin
  const line = P1_LINES[count % P1_LINES.length];
  await sendText(psid, line);

  session.nudges = session.nudges || {};
  session.nudges.p1 = { lastAt: Date.now(), count: count + 1 };
}

export async function maybeNudgeDocs(psid, session) {
  const conf = cfg.docs;
  if (isQuiet(conf)) return;

  if (!session.docs || session.docs.awaiting === false) return;

  const startedAt = session.docsStartedAt || session._docsAskedAt || session.updatedAt || 0;
  const hours = (Date.now() - startedAt) / 3600000;
  if (hours > (conf.max_hours || 72)) return;

  const last = session.nudges?.docs?.lastAt || 0;
  const gapMs = (conf.interval_min || 120) * 60 * 1000;
  if (Date.now() - last < gapMs) return;

  const count = session.nudges?.docs?.count || 0;
  const lines = [
    "Reminder lang—send mo dito yung basic docs para ma-pre-approve ka agad. 👍",
    "Kahit photo ng ID + proof of income muna. Iche-check namin agad.",
    "Once ma-receive, tawag kami para i-fast track ang approval."
  ];
  const line = lines[count % lines.length];
  await sendText(psid, line);

  session.nudges = session.nudges || {};
  session.nudges.docs = { lastAt: Date.now(), count: count + 1 };
}
