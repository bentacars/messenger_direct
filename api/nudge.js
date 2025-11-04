// /api/nudge.js
// Runtime: Node serverless (Vercel)
export const config = { runtime: 'nodejs' };

import { sendText, sendTypingOn, sendTypingOff } from '../server/lib/messenger.js';

// Optional bearer auth for cron
const CRON_SECRET = process.env.CRON_SECRET || '';

// Upstash REST (Vercel KV compatible)
const KV_URL   = process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';

/* -------------------- Time helpers (Asia/Manila quiet hours) -------------------- */
const nowUtc = () => new Date();
const toManila = (d = nowUtc()) =>
  new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
const manilaHour = (d = nowUtc()) => toManila(d).getHours();
const withinQuietHoursManila = () => {
  // Quiet hours: 21:00–08:59
  const h = manilaHour();
  return h >= 21 || h < 9;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* -------------------- KV helpers -------------------- */
async function kvListSessions(prefix = 'session:') {
  if (!KV_URL || !KV_TOKEN) return [];
  const r = await fetch(`${KV_URL}/keys/${encodeURIComponent(prefix)}*`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return [];
  const keys = await r.json();
  return Array.isArray(keys) ? keys : [];
}
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
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
    { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}` } }
  );
  return r.ok;
}

/* -------------------- Tone B nudge lines -------------------- */
const phase1Variants = [
  "Quick lang: cash or financing plan mo? Para ma-match kita agad.",
  "Saan location mo (city/province)? Iche-check ko pinakamalapit na units.",
  "Body type mo? sedan / SUV / MPV / van / pickup — or ‘any’.",
  "Auto or manual prefer mo? (pwede rin ‘any’)",
  "Budget range? (cash SRP or cash-out kung financing) para tumama ang options."
];

const docsVariants = [
  "While securing your slot, puwede mong i-send dito ang IDs at basic docs para ma pre-approve ka na rin. 👍",
  "Reminder: send mo na ang basic docs (IDs & proof of income) para mabilisan ang approval.",
  "Kahit clear photos ok — IDs + income proof — i-review namin agad."
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function nextPhase1Prompt(sess) {
  const order = [];
  if (sess?.needPayment)      order.push("Cash or financing plan mo?");
  if (sess?.needLocation)     order.push("Saan location mo (city/province)?");
  if (sess?.needBodyType)     order.push("Body type? sedan/SUV/MPV/van/pickup — or ‘any’.");
  if (sess?.needTransmission) order.push("Auto or manual? (pwede ‘any’)");
  if (sess?.needBudget)       order.push("Budget range? (cash SRP o cash-out kung financing)");
  return order[0] || pick(phase1Variants);
}

/* -------------------- Nudge engines -------------------- */
const FIFTEEN_MIN = 15 * 60 * 1000;
const TWO_HOURS   = 2 * 60 * 60 * 1000;
const THREE_DAYS  = 3 * 24 * 60 * 60 * 1000;

async function nudgePhase1(sess) {
  const { psid, lastActivityTs = 0, phase1 = {} } = sess;
  const { nudgeCount = 0, lastNudgeTs = 0 } = phase1;

  const now = Date.now();
  const idleLongEnough = now - lastActivityTs >= FIFTEEN_MIN;
  const spacedFromLast = now - lastNudgeTs >= FIFTEEN_MIN;
  const underMax       = nudgeCount < 8;

  if (!idleLongEnough || !spacedFromLast || !underMax) return false;
  if (withinQuietHoursManila()) return false;

  const prompt = nextPhase1Prompt(sess);
  await sendTypingOn(psid);
  await sleep(700);
  await sendText(psid, prompt);
  await sendTypingOff(psid);

  sess.phase1 = { nudgeCount: nudgeCount + 1, lastNudgeTs: now };
  await kvSet(`session:${psid}`, sess);
  return true;
}

async function nudgeDocs(sess) {
  const { psid, docs = {} } = sess;
  const { awaitingDocs = false, startedAtTs = 0, lastNudgeTs = 0, nudgeCount = 0 } = docs;
  if (!awaitingDocs) return false;

  const now = Date.now();
  if (startedAtTs && now - startedAtTs > THREE_DAYS) {
    if (!withinQuietHoursManila()) {
      await sendTypingOn(psid);
      await sleep(600);
      await sendText(psid, "Maghihinto muna ako sa follow-ups. If gusto mong ituloy, reply ka lang dito anytime. 🙌");
      await sendTypingOff(psid);
    }
    sess.docs = { awaitingDocs: false, startedAtTs, lastNudgeTs: now, nudgeCount };
    await kvSet(`session:${psid}`, sess);
    return true;
  }

  const spaced = now - lastNudgeTs >= TWO_HOURS;
  if (!spaced || withinQuietHoursManila()) return false;

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

/* -------------------- HTTP handler -------------------- */
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

    if (!KV_URL || !KV_TOKEN) {
      return res.status(200).json({ ok: true, info: 'KV not configured; skipped.' });
    }

    const keys = await kvListSessions('session:');
    let processed = 0, nudged = 0;

    for (const key of keys) {
      const sess = await kvGet(key);
      if (!sess || !sess.psid) continue;
      processed += 1;

      // Prioritize docs nudges if in that phase
      if (await nudgeDocs(sess)) { nudged += 1; continue; }
      if (await nudgePhase1(sess)) nudged += 1;
    }

    return res.status(200).json({ ok: true, processed, nudged, quiet: withinQuietHoursManila() });
  } catch (err) {
    console.error('nudge error', err);
    return res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
}
