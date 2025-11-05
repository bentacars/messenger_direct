// server/lib/session.js
// Upstash KV-backed session with idle tracking & pause state.
// Falls back to in-memory if KV env vars are missing.

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TTL_DAYS = Number(process.env.MEMORY_TTL_DAYS || 14);
const TTL_SEC  = TTL_DAYS * 24 * 60 * 60;

const mem = new Map();
function now() { return Date.now(); }

async function kvPipeline(cmd, ...args) {
  if (!KV_URL || !KV_TOKEN) return null; // fall back to memory
  const res = await fetch(KV_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ pipeline: [[cmd, ...args]] })
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out?.error || `KV ${cmd} failed`);
  return out?.results?.[0];
}

const key = (pid) => `sess:${pid}`;

export async function getSession(pid) {
  if (!KV_URL || !KV_TOKEN) return mem.get(pid) || null;
  const r = await kvPipeline("GET", key(pid));
  if (!r?.result) return null;
  try { return JSON.parse(r.result); } catch { return null; }
}

export async function saveSession(pid, patch = {}) {
  const cur = (await getSession(pid)) || {};
  const session = {
    ...cur,
    ...patch,
    pid,
    updatedAt: now(),
    lastInteractionAt: patch.lastInteractionAt ?? cur.lastInteractionAt ?? now(),
    nudgeLevel: patch.nudgeLevel ?? cur.nudgeLevel ?? 0,
    paused: patch.paused ?? cur.paused ?? false
  };

  if (!KV_URL || !KV_TOKEN) {
    mem.set(pid, session);
    return session;
  }

  await kvPipeline("SET", key(pid), JSON.stringify(session), "EX", TTL_SEC);
  await kvPipeline("SADD", "sess:index", pid);
  return session;
}

export async function clearSession(pid) {
  if (!KV_URL || !KV_TOKEN) {
    mem.delete(pid);
    return;
  }
  await kvPipeline("DEL", key(pid));
  await kvPipeline("SREM", "sess:index", pid);
}

export async function listAllSessionPids() {
  if (!KV_URL || !KV_TOKEN) return Array.from(mem.keys());
  const r = await kvPipeline("SMEMBERS", "sess:index");
  return r?.result || [];
}
