// /api/nudge.js
// Runtime: Node serverless (Vercel)
export const config = { runtime: 'nodejs' };

import { sendText, sendTypingOn, sendTypingOff } from './lib/messenger.js';

// Optional bearer auth for cron (set in Vercel env if you want)
const CRON_SECRET = process.env.CRON_SECRET || '';

// Vercel KV (Upstash REST)
const KV_URL   = process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';

// ---- Tone pack (assertive-friendly) ----
// If you prefer to import from /server/tone/nudge.js at runtime, you can.
// But keeping a local copy here avoids JSON import asserts on Vercel.
const phase1Variants = [
  "Quick check lang — cash or financing plan mo? Para maitama ko agad ang match.",
  "Saan location mo (city/province)? Iche-check ko yung pinakamalapit na units.",
  "Anong body type mo — sedan, SUV, MPV, van, pickup? ‘Any’ ok din.",
  "Transmission preference — automatic, manual, or ‘any’?",
  "Budget range mo? (cash SRP or cash-out kung financing) para tumama ang options."
];

const docsVariants = [
  "While securing your viewing slot, send mo na rito ang valid ID at basic docs para ma-pre-approve ka na rin. 🚀",
  "Reminder lang — kung ok, pa-send ng basic docs (IDs + proof of income) para mabilis ang approval.",
  "Pa-abot ng clear photos ng IDs at income proof dito para ma-fast track natin.",
];

const finalPhase1Stop = "Babalik muna ako later. Gusto mong mag-Continue o Not interested?";
const docsStop        = "Maghihinto muna ako sa follow-ups. If gusto mong ituloy, reply ka lang dito at tutulungan kitang tapusin ang approval.";

// ---- Time helpers (Manila quiet hours) ----
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

// ---- KV helpers (Upstash REST) ----
async function kvListSessions(prefix = 'session:') {
  if (!KV_URL || !KV_TOKEN) return [];
  const url = `${KV_URL}/keys/${encodeURIComponent(prefix)}*`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    method: 'GET',
  });
  if (!r.ok) return [];
  const keys = await r.json();
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
  const raw = data?.result;
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  const r = await fetch(
    `${KV_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(body)}`,
    { headers: { Authorization: `Bearer ${KV_TOKEN}` }, method: 'POST' }
  );
  return r.ok;
}

// ---- Core nudge logic ----
const FIFTEEN_MIN = 15 * 60 * 1000;
const TWO_HOURS   = 2 * 60 * 60 * 1000;
const THREE_DAYS  = 3 * 24 * 60 * 60 * 1000;

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function nextPhase1Prompt(sess) {
  // If your session flags missing fields, prioritize them
  const order = [];
  if (sess?.needPayment)      order.push("Cash or financing plan mo?");
  if (sess?.needLocation)     order.push("Saan location mo (city/province)?");
  if (sess?.needBodyType)     order.push("Anong body type mo — sedan, SUV, MPV, van, pickup? ‘Any’ ok din.");
  if (sess?.needTransmission) order.push("Transmission — automatic, manual, or ‘any’?");
  if (sess?.needBudget)       order.push("Budget range mo? (cash SRP or cash-out kung financing)");

  if (order.length) return order[0];
  return pick(phase1Variants);
}

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
  await sleep(700);
  await sendText(psid, prompt);
  await sendTypingOff(psid);

  sess.phase1 = { nudgeCount: nudgeCount + 1, lastNudgeTs: now };
  await kvSet(`session:${psid}`, sess);

  // If exactly 8th attempt was just sent, follow with final stop prompt next cycle
  if (sess.phase1.nudgeCount >= 8) {
    await sleep(500);
    await sendText(psid, finalPhase1Stop);
  }
  return true;
}

async function nudgeDocs(sess) {
  const { psid, docs = {} } = sess;
  const {
    awaitingDocs = false,
    startedAtTs = 0,
    lastNudgeTs = 0,
    nudgeCount = 0
  } = docs;

  if (!awaitingDocs) return false;

  const now = Date.now();
  if (startedAtTs && now - startedAtTs > THREE_DAYS) {
    if (!withinQuietHoursManila()) {
      await sendTypingOn(psid);
      await sleep(600);
      await sendText(psid, docsStop);
      await sendTypingOff(psid);
    }
    sess.docs = { awaitingDocs: false, startedAtTs, lastNudgeTs: now, nudgeCount };
    await kvSet(`session:${psid}`, sess);
    return true;
  }

  const spacedFromLast = now - lastNudgeTs >= TWO_HOURS;
  if (!spacedFromLast || withinQuietHoursManila()) return false;

  await sendTypingOn(psid);
  await sleep(600);
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

// ---- HTTP handler (Vercel)
export default async function handler(req, res) {
  try {
    // Optional cron bearer check
    if (CRON_SECRET) {
      const auth = req.headers['authorization'] || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (token !== CRON_SECRET) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
      }
    }

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
      if (!sess || !sess.psid) continue;
      processed += 1;

      // Priority: docs nudges (if in docs-collection phase)
      const didDocs = await nudgeDocs(sess);
      if (didDocs) { nudged += 1; continue; }

      // Otherwise Phase 1 nudges
      const didP1 = await nudgePhase1(sess);
      if (didP1) nudged += 1;
    }

    return res.status(200).json({ ok: true, processed, nudged, quiet: withinQuietHoursManila() });
  } catch (err) {
    console.error('nudge error', err);
    return res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
}
