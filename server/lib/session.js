// server/lib/session.js
// Upstash Redis REST-backed session with idle tracking & pause state.
// Falls back to in-memory if REST env vars are missing.

const KV_URL =
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL || ""; // accept either env name
const KV_TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN || "";
const TTL_DAYS = Number(process.env.MEMORY_TTL_DAYS || 14);
const TTL_SEC = TTL_DAYS * 24 * 60 * 60;

// Ensure we hit the pipeline endpoint
const PIPE_URL =
  KV_URL
    ? (KV_URL.endsWith("/pipeline") ? KV_URL : KV_URL.replace(/\/+$/, "") + "/pipeline")
    : "";

const mem = new Map();
const now = () => Date.now();

async function kvPipeline(cmd, ...args) {
  if (!PIPE_URL || !KV_TOKEN) return null; // memory fallback
  const res = await fetch(PIPE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json",
    },
    // Upstash Redis REST expects an array of commands (arrays), NOT {pipeline: ...}
    body: JSON.stringify([[cmd, ...args]]),
  });
  const text = await res.text();
  let out = {};
  try { out = JSON.parse(text); } catch { /* leave as {} */ }
  if (!res.ok) {
    console.error("KV error:", res.status, text);
    throw new Error(out?.error || `KV ${cmd} failed`);
  }
  // Response format: { result: [ { result: "..." } ] } or { result: [ { error: "..."} ] }
  const first = Array.isArray(out?.result) ? out.result[0] : null;
  if (first && first.error) throw new Error(first.error);
  return first;
}

const key = (pid) => `sess:${pid}`;

export async function getSession(pid) {
  // memory mode
  if (!PIPE_URL || !KV_TOKEN) return mem.get(pid) || null;

  const r = await kvPipeline("GET", key(pid));
  const str = r?.result;
  if (!str) return null;
  try { return JSON.parse(str); } catch { return null; }
}

export async function saveSession(pid, patch = {}) {
  const cur = (await getSession(pid)) || {};
  const session = {
    ...cur,
    ...patch,
    pid,
    updatedAt: now(),
    lastInteractionAt:
      patch.lastInteractionAt ?? cur.lastInteractionAt ?? now(),
    nudgeLevel: patch.nudgeLevel ?? cur.nudgeLevel ?? 0,
    paused: patch.paused ?? cur.paused ?? false,
  };

  // memory mode
  if (!PIPE_URL || !KV_TOKEN) {
    mem.set(pid, session);
    return session;
  }

  await kvPipeline("SETEX", key(pid), String(TTL_SEC), JSON.stringify(session));
  // also keep an index of all sessions for the nudge cron
  await kvPipeline("SADD", "sess:index", pid);
  return session;
}

export async function clearSession(pid) {
  if (!PIPE_URL || !KV_TOKEN) {
    mem.delete(pid);
    return;
  }
  await kvPipeline("DEL", key(pid));
  await kvPipeline("SREM", "sess:index", pid);
}

export async function listAllSessionPids() {
  if (!PIPE_URL || !KV_TOKEN) return Array.from(mem.keys());
  const r = await kvPipeline("SMEMBERS", "sess:index");
  // SMEMBERS returns { result: ["id1","id2",...] }
  return Array.isArray(r?.result) ? r.result : [];
}
