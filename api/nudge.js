// api/nudge.js
// Vercel Node serverless function that nudges:
//  - Phase 1 idle users every 15m (max 8 times; quiet 9pm–9am Manila)
//  - Docs follow-ups every 2h up to 3 days (same quiet hours)

export const config = { runtime: 'nodejs' };

import { sendText, sendTypingOn, sendTypingOff } from './lib/messenger.js';

// Optional auth (cron secret). If empty, no auth required.
const CRON_SECRET = process.env.CRON_SECRET || "";

// Vercel KV (Upstash REST)
const KV_URL   = process.env.KV_REST_API_URL || process.env.KV_REST_API_KV_URL || "";
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.KV_REST_API_READ_ONLY_TOKEN || "";

// ---------- time helpers ----------
const nowUtc = () => new Date();
const toManila = (d = nowUtc()) =>
  new Date(d.toLocaleString("en-US", { timeZone: "Asia/Manila" }));
const manilaHour = (d = nowUtc()) => toManila(d).getHours();

// Quiet hours: 21:00–08:59 (Manila)
const withinQuietHoursManila = () => {
  const h = manilaHour();
  return h >= 21 || h < 9;
};

// ---------- misc ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---------- KV helpers ----------
async function kvKeys(prefix = "session:") {
  if (!KV_URL || !KV_TOKEN) return [];
  const r = await fetch(`${KV_URL}/keys/${encodeURIComponent(prefix)}*`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return [];
  const data = await r.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const raw = j?.result ?? null;
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}
async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  const body = typeof value === "string" ? value : JSON.stringify(value);
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(body)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  return r.ok;
}

// ---------- message variants ----------
const phase1Variants = [
  "Quick one lang: cash or financing ang plan mo? Para ma-match kita agad.",
  "Saan location mo (city/province)? Iche-check ko yung pinakamalapit na units.",
  "Anong body type mo—sedan, SUV, MPV—o ‘any’ ok din.",
  "Auto or manual ang prefer mo? (Pwede rin ‘any’)",
  "Budget range mo? (cash SRP or cash-out kung financing)"
];
const docsVariants = [
  "Hi! While locking your viewing slot, puwede mong i-send dito ang IDs at basic docs para ma-pre-approve ka na rin. 😊",
  "Reminder lang—send mo na dito ang basic docs (IDs & proof of income) para ma-fast track natin ang approval.",
  "May I request your basic docs here? Kahit malinaw na photos ok na, we’ll review ASAP."
];

// If your session saves which fields are missing, prefer asking that first.
function nextPhase1Prompt(sess) {
  const o = [];
  if (sess?.needPayment)      o.push("Cash or financing ang plan mo?");
  if (sess?.needLocation)     o.push("Saan location mo (city/province)?");
  if (sess?.needBodyType)     o.push("Anong body type mo (sedan/SUV/MPV/van/pickup—o ‘any’)?");
  if (sess?.needTransmission) o.push("Auto or manual? (Pwede rin ‘any’)");
  if (sess?.needBudget)       o.push("Budget range mo? (cash SRP o cash-out kung financing)");
  return o.length ? o[0] : pick(phase1Variants);
}

// ---------- cadence constants ----------
const FIFTEEN_MIN = 15 * 60 * 1000;
const TWO_HOURS   = 2 * 60 * 60 * 1000;
const THREE_DAYS  = 3 * 24 * 60 * 60 * 1000;

// ---------- nudge engines ----------
async function nudgePhase1(sess) {
  const { psid, lastActivityTs = 0, phase1 = {} } = sess;
  const { nudgeCount = 0, lastNudgeTs = 0 } = phase1;

  const now = Date.now();
  const idle15m      = now - lastActivityTs >= FIFTEEN_MIN;
  const spaced15m    = now - lastNudgeTs   >= FIFTEEN_MIN;
  const under8       = nudgeCount < 8;

  if (!idle15m || !spaced15m || !under8) return false;
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
  const {
    awaitingDocs = false,
    startedAtTs = 0,
    lastNudgeTs = 0,
    nudgeCount = 0
  } = docs;

  if (!awaitingDocs) return false;

  const now = Date.now();

  // Stop completely after 3 days with a closing note
  if (startedAtTs && now - startedAtTs > THREE_DAYS) {
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

  // 2-hour spacing
  if (now - lastNudgeTs < TWO_HOURS) return false;
  if (withinQuietHoursManila()) return false;

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

// ---------- handler ----------
export default async function handler(req, res) {
  try {
    // Optional auth: either Authorization: Bearer <CRON_SECRET> OR ?secret=<CRON_SECRET>
    if (CRON_SECRET) {
      const hdr = req.headers['authorization'] || '';
      const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
      const qs = (req.query?.secret || req.query?.SECRET || '').toString();
      if (bearer !== CRON_SECRET && qs !== CRON_SECRET) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
      }
    }

    if (!KV_URL || !KV_TOKEN) {
      return res.status(200).json({ ok: true, info: 'KV not configured; skipped.' });
    }

    const keys = await kvKeys('session:');
    let processed = 0, nudged = 0;

    for (const key of keys) {
      const sess = await kvGet(key);
      if (!sess?.psid) continue;
      processed += 1;

      // Prioritize docs nudges over phase 1
      const didDocs = await nudgeDocs(sess);
      if (didDocs) { nudged++; continue; }

      const didP1 = await nudgePhase1(sess);
      if (didP1) nudged++;
    }

    return res.status(200).json({
      ok: true,
      processed,
      nudged,
      quiet: withinQuietHoursManila()
    });
  } catch (err) {
    console.error('nudge error', err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
