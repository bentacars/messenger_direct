import fetch from "node-fetch";

export default async function handler(req, res) {
  const PAGE_ID = process.env.PAGE_ID;
  const TOKEN = process.env.PAGE_ACCESS_TOKEN;

  if (!PAGE_ID || !TOKEN) {
    return res.status(400).json({ ok: false, error: "Missing PAGE_ID or PAGE_ACCESS_TOKEN" });
  }

  try {
    const url = `https://graph.facebook.com/v19.0/${PAGE_ID}/subscribed_apps`;
    const params = new URLSearchParams({
      access_token: TOKEN,
      subscribed_fields: [
        "messages",
        "messaging_postbacks",
        "messaging_optins",
        "messaging_referrals",
      ].join(","),
    });

    const fbRes = await fetch(url, { method: "POST", body: params });
    const json = await fbRes.json();
    return res.json({ ok: fbRes.ok, result: json });
  } catch (err) {
    return res.status(500).json({ ok: false, fatal: String(err) });
  }
}
