// server/lib/session.js
// Uses Upstash Redis KV. Auto-JSON, per-PSID session keys.

import { Redis } from "@upstash/redis";
import { SESSION_TTL_DAYS } from "./constants.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TTL_SECONDS = SESSION_TTL_DAYS * 24 * 60 * 60;

export async function getSession(psid) {
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
  const key = `session:${psid}`;
  try {
    await redis.set(key, data, { ex: TTL_SECONDS });
  } catch (e) {
    console.error("[session] SET failed", e);
  }
}
