// api/nudge.js
// Runtime: Node serverless (Vercel)
export const config = { runtime: 'nodejs' };

import { sendText, sendTypingOn, sendTypingOff } from './lib/messenger.js';

// Optional bearer auth for cron
const CRON_SECRET = process.env.CRON_SECRET || '';

// Vercel KV (Upstash) REST (optional but recommended)
const KV_URL   = process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';

// ----- Utilities -----
const nowUtc = () => new Date();
const toManila = (d = nowUtc()) =>
  new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
const manilaHour = (d = nowUtc()) => toManila(d).getHours();

const withinQuietHoursManila = () => {
  // Quiet hours: 21:00–08:59 Asia/Manila
  const h = manilaHour();
  return h >= 21 || h < 9;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----- KV helpers (work with Vercel KV / Upstash REST) -----
async function kvListSessions(prefix = 'session:') {
  if (!KV_URL || !KV_TOKEN) return []; // no KV configured
  const url = `${KV_URL}/keys/${encodeURIComponent(prefix)}*`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    method: 'GET',
  });
  if (!r.ok) return [];
  const keys = await r.json(); // array of keys
  return Array.isArray(keys) ? keys : [];
}

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    method: 'GET',
  });
  if (!r.ok) return null;
  const data = await r.json();
  // Upstash returns { result: "..." } for strings
  const raw = data?.result;
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(body)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    method: 'POST',
  });
  return r.ok;
}

// ----- Nudge message variants -----
const phase1Variants = [
  "Quick one lang: cash or financing ang plan mo? Para ma-match kita agad.",
  "Saan location mo (city/province)? Iche-check ko yung pinakamalapit na units.",
  "Anong body type mo: sedan, SUV, MPV—o ‘any’ ok din.",
  "Auto or manual prefer mo? Pwede rin ‘any’.",
  "Budget range mo? (cash SRP or cash-out kung financing) Para tumama ang suggestions."
];

const docsVariants = [
  "Hi! While securing your viewing slot, puwede mong i-send dito ang IDs at basic docs para ma-pre-approve ka na rin. 😊",
  "Reminder lang—send mo na dito ang basic docs (IDs & proof of income) para ma-fast track natin ang approval.",
  "May I request your basic docs here? Kahit clear photos ok na, we’ll review ASAP."
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Decide next gentle prompt for Phase 1 (based on missing fields, if your session stores them)
function nextPhase1Prompt(sess) {
  // If your session tracks missing fields like {needPayment, needLocation,...}, prefer those
  const order = [];
  if (sess?.needPayment) order.push("Cash or financing ang plan mo?");
  if (sess?.needLocation) order.push("Saan location mo (city/province)?");
  if (sess?.needBodyType) order.push("Anong body type mo (sedan/SUV/MPV/van/pickup—o ‘any’)?");
  if (sess?.needTransmission) order.push("Auto or manual? (Pwede rin ‘any’)");
  if (sess?.needBudget) order.push("Budget range mo? (cash SRP o cash-out kung financing)");

  if (order.length) {
    return order[0]; // ask the highest-priority missing item
  }
  // Fallback to a random, still-human line:
  return pick(phase1Variants);
}

// ----- Core nudge logic -----
const FIFTEEN_MIN = 15 * 60 * 1000;
const TWO_HOURS   = 2 * 60 * 60 * 1000;
const THREE_DAYS  = 3 * 24 * 60 * 60 * 1000;

async function nudgePhase1(sess) {
  const { psid, lastActivityTs = 0, phase1 = {} } = sess;
  const { nudgeCount = 0, lastNudgeTs = 0 } = phase1;

  const now = Date.now();
  const idleLongEnough  = now - lastActivityTs >= FIFTEEN_MIN;
  const spacedFromLast  = now - lastNudgeTs >= FIFTEEN_MIN;
  const underMax        = nudgeCount < 8;

  if (!idleLongEnough || !spacedFromLast || !underMax) return false;
  if (withinQuietHoursManila()) return false;

  const prompt = nextPhase1Prompt(sess);
  await sendTypingOn(psid);
  await sleep(800);
  await sendText(psid, prompt);
  await sendTypingOff(psid);

  // update counters
  sess.phase1 = { nudgeCount: nudgeCount + 1, lastNudgeTs: now };
  await kvSet(`session:${psid}`, sess);
  return true;
}

async function nudgeDocs(sess) {
  const { psid, docs = {} } = sess;
  const {
    awaitingDocs = false,
    startedAtTs = 0,          // when we began asking for docs
    lastNudgeTs = 0,
    nudgeCount = 0
  } = docs;

  if (!awaitingDocs) return false;

  const now = Date.now();
  // total window 3 days from startedAtTs
  if (startedAtTs && now - startedAtTs > THREE_DAYS) {
    // stop nudging permanently after final message
    if (!withinQuietHoursManila()) {
      await sendTypingOn(psid);
      await sleep(600);
      await sendText(psid, "Maghihinto muna ako sa follow-ups. If gusto mong ituloy anytime, just reply here and I’ll help you finish the approval. 👍");
      await sendTypingOff(psid);
    }
    sess.docs = { awaitingDocs: false, startedAtTs, lastNudgeTs: now, nudgeCount };
    await kvSet(`session:${psid}`, sess);
    return true;
  }

  const spacedFromLast = now - lastNudgeTs >= TWO_HOURS;
  if (!spacedFromLast || withinQuietHoursManila()) return false;

  await sendTypingOn(psid);
  await sleep(700);
  await sendText(psid, pick(docsVariants));
  await sendTypingOff(psid);

  sess.docs = {
    awaitingDocs: true,
    startedAtTs: startedAtTs || now,
    lastNudgeTs: now,
    nudgeCount: (nudgeCount || 0) + 1
  };
  await kvSet(`session:${psid}`, sess);
  return true;
}

// ----- Handler -----
export default async function handler(req, res) {
  try {
    // Optional cron auth
    if (CRON_SECRET) {
      const auth = req.headers['authorization'] || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (token !== CRON_SECRET) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
      }
    }

    // If no KV configured, exit gracefully so cron stays green
    if (!KV_URL || !KV_TOKEN) {
      return res.status(200).json({ ok: true, info: 'KV not configured; nudge pass skipped.' });
    }

    const keys = await kvListSessions('session:');
    if (!keys.length) {
      return res.status(200).json({ ok: true, processed: 0, nudged: 0 });
    }

    let processed = 0;
    let nudged    = 0;

    for (const key of keys) {
      const sess = await kvGet(key);
      // Expected minimal shape; skip if broken
      if (!sess || !sess.psid) continue;

      processed += 1;

      // If user replied recently, some other part of your webhook should update:
      //   sess.lastActivityTs = Date.now()
      //   sess.phase = 'phase1' | 'phase2' | 'financingDocs' etc.

      // Try docs nudges first (higher priority once they're in that phase)
      const didDocs = await nudgeDocs(sess);
      if (didDocs) { nudged += 1; continue; }

      // Otherwise, Phase 1 idle nudges
      const didP1 = await nudgePhase1(sess);
      if (didP1) nudged += 1;
    }

    return res.status(200).json({ ok: true, processed, nudged, quiet: withinQuietHoursManila() });
  } catch (err) {
    console.error('nudge error', err);
    return res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
}
