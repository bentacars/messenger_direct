// api/debug-webhook.js
export const config = { runtime: "nodejs" };

/**
 * This endpoint prints EVERYTHING Facebook sends,
 * without replying, so we can detect webhook activity.
 */
export default async function handler(req, res) {
  try {
    console.log("🔍 DEBUG WEBHOOK EVENT ----");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("🔍 END EVENT ----------------");

    // ALWAYS respond 200 or Meta will retry
    return res.status(200).json({ ok: true, received: true });
  } catch (err) {
    console.error("❌ debug-webhook error", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
