// /api/debug-env.js
export default function handler(req, res) {
  const token = process.env.PAGE_ACCESS_TOKEN || "";
  const redisURL =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    "missing";
  const redisToken =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    "missing";

  res.json({
    PAGE_ACCESS_TOKEN: token
      ? `✅ LOADED (${token.length} chars)`
      : "❌ MISSING",
    token_starts_with: token ? token.substring(0, 6) : null,
    redis_url: redisURL ? "✅ EXISTS" : "❌ MISSING",
    redis_token: redisToken ? "✅ EXISTS" : "❌ MISSING",
  });
}
