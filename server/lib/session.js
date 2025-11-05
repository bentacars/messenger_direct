// server/lib/session.js
// Stores session/state data per user (7-day memory window)
// Requires Vercel KV binding: KV_REST_API_URL + KV_REST_API_TOKEN

import fetch from "node-fetch";

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

if (!KV_URL || !KV_TOKEN) {
  console.warn("[session] Missing KV_REST_API_URL or KV_REST_API_TOKEN");
}

function pk(psid) {
  return `session:${psid}`;
}

async function kvFetch(method, key, body) {
  const url = `${KV_URL}/v1/kv/${key}`;
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error(`[session] KV error ${method} ${key}`, r.status, t);
  }
  return r;
}

export async function getSession(psid) {
  const r = await kvFetch("GET", pk(psid));
  if (!r || !r.ok) return null;
  try {
    return await r.json();
  } catch {
    return null;
  }
}

export async function setSession(psid, data = {}) {
  await kvFetch("PUT", pk(psid), data);
  return data;
}

export async function clearSession(psid) {
  await kvFetch("DELETE", pk(psid));
}

export async function touchSession(psid) {
  const sess = (await getSession(psid)) || {};
  sess.updated_at = Date.now();
  await setSession(psid, sess);
  return sess;
}
