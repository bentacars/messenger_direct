// api/nudge.js
import { sendFollowUps } from "../server/lib/nudges.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    await sendFollowUps();
    return res.status(200).json({ ok: true, status: "nudges sent" });
  } catch (err) {
    console.error("Nudge error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
