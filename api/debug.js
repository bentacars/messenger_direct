// api/debug-token.js
export const config = { runtime: "nodejs" };

const G = (path) => `https://graph.facebook.com/v20.0${path}`;

export default async function handler(req, res) {
  try {
    const PAGE_ACCESS_TOKEN = (process.env.PAGE_ACCESS_TOKEN || "").trim();
    const APP_ID = (process.env.APP_ID || "").trim();
    const APP_SECRET = (process.env.APP_SECRET || "").trim();

    const meta = {
      present: !!PAGE_ACCESS_TOKEN,
      length: PAGE_ACCESS_TOKEN.length,
      startsWith_EA: PAGE_ACCESS_TOKEN.startsWith("EA"),
      first5: PAGE_ACCESS_TOKEN.slice(0, 5),
      last4: PAGE_ACCESS_TOKEN.slice(-4),
      contains_space: /\s/.test(PAGE_ACCESS_TOKEN),
      env: process.env.VERCEL_ENV || "unknown",
    };

    // Quick fail if missing
    if (!PAGE_ACCESS_TOKEN) {
      return res.status(200).json({
        ok: false,
        reason: "PAGE_ACCESS_TOKEN is empty or missing in Vercel env.",
        meta,
      });
    }

    const results = {};

    // 1) Simple "me" check – MUST return your Page id & name if the token is valid
    results.me = await fetch(G(`/me?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`))
      .then(r => r.json())
      .catch(e => ({ error: String(e) }));

    // 2) Subscribed apps – confirms the Page is connected to your app
    results.subscribed_apps = await fetch(G(`/me/subscribed_apps?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`))
      .then(r => r.json())
      .catch(e => ({ error: String(e) }));

    // 3) Debug token (optional but best) – needs APP_ID|APP_SECRET
    if (APP_ID && APP_SECRET) {
      const inspector = `${APP_ID}|${APP_SECRET}`;
      results.debug_token = await fetch(
        G(`/debug_token?input_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}&access_token=${encodeURIComponent(inspector)}`)
      )
        .then(r => r.json())
        .catch(e => ({ error: String(e) }));
    } else {
      results.debug_token = { skipped: true, reason: "APP_ID or APP_SECRET not set" };
    }

    // 4) Try a harmless Messenger send to the Page itself (will fail silently without a PSID)
    // We skip actual send here; this endpoint is read-only diagnostics.

    const ok =
      results.me?.id &&
      !results.me?.error &&
      (!results.debug_token?.error || results.debug_token?.data) &&
      !results.subscribed_apps?.error;

    return res.status(200).json({ ok, meta, results });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err) });
  }
}
