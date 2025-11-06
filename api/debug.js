// /api/debug.js
import fetch from "node-fetch";
import { getSession } from "../server/lib/session.js";
import { sendMessage } from "../server/lib/messenger.js";

const PAGE_ID = process.env.PAGE_ID;
const TOKEN = process.env.PAGE_ACCESS_TOKEN;

export default async function handler(req, res) {
  const results = {};

  // ---- 1. Check token presence ----
  results.token = TOKEN
    ? { ok: true, length: TOKEN.length, starts_with: TOKEN.substring(0, 6) }
    : { ok: false, error: "PAGE_ACCESS_TOKEN missing" };

  // ---- 2. Check FB debug endpoint ----
  try {
    const fb = await fetch(
      `https://graph.facebook.com/v19.0/me?access_token=${TOKEN}`
    ).then((r) => r.json());
    results.fb_me = fb.error ? { ok: false, error: fb.error } : fb;
  } catch (err) {
    results.fb_me = { ok: false, fatal: String(err) };
  }

  // ---- 3. Check webhook subscription ----
  try {
    const sub = await fetch(
      `https://graph.facebook.com/v19.0/${PAGE_ID}/subscribed_apps?access_token=${TOKEN}`
    ).then((r) => r.json());
    results.webhook = sub.error ? { ok: false, error: sub.error } : sub;
  } catch (err) {
    results.webhook = { ok: false, fatal: String(err) };
  }

  // ---- 4. Redis test ----
  try {
    const test = await getSession("DEBUG_TEST");
    results.redis = test ? { ok: true, sample: test } : { ok: false };
  } catch (err) {
    results.redis = { ok: false, fatal: String(err) };
  }

  // ---- 5. Optional: Send test message to page ----
  if (req.query.test_send && req.query.psid) {
    const sent = await sendMessage(req.query.psid, "✅ Debug send working!");
    results.test_send = sent || { error: true };
  }

  return res.json(results);
}
