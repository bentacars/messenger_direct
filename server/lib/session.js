// server/lib/session.js
// Upstash Redis KV session handler with auto-fallback env detection

import { Redis } from "@upstash/redis";
import { SESSION_TTL_DAYS } from "./constants.js";

// ✅ Accept all possible Redis env var names (works with Vercel KV integration)
const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  process.env.KV_URL ||
  null;

const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  process.env.KV_TOKEN ||
  null;

// ✅ Create Redis client only if env vars exist
export const redis =
  REDIS_URL && REDIS_TOKEN ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null;

const TTL_SECONDS = SESSION_TTL_DAYS * 24 * 60 * 60;

// ✅ Safe JSON formatter (prevents circular socket JSON crash)
function safe(obj) {
  try {
    return JSON.parse(JSON.stringify(obj || {}));
  } catch {
    return {};
  }
}

export async function getSession(psid) {
  if (!redis) {
    console.error("[session] Redis missing URL/TOKEN envs");
    return { psid, createdAt: Date.now() };
  }
  const key = `session:${psid}`;
  try {
    const data = await redis.get(key);
    return data || { psid, createdAt: Date.now() };
  } catch (e) {
    console.error("[session] GET failed", e);
    return { psid, createdAt: Date.now() };
  }
}

export async function setSession(psid, data) {
  if (!redis) {
    console.error("[session] Redis missing URL/TOKEN envs");
    return;
  }
  const key = `session:${psid}`;
  try {
    await redis.set(key, safe(data), { ex: TTL_SECONDS });
  } catch (e) {
    console.error("[session] SET failed", e);
  }
}

export async function clearSession(psid) {
  if (!redis) return;
  try {
    await redis.del(`session:${psid}`);
  } catch (e) {
    console.error("[session] DEL failed", e);
  }
}
