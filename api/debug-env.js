export default function handler(req, res) {
  res.json({
    PAGE_ACCESS_TOKEN: process.env.PAGE_ACCESS_TOKEN ? "✅ LOADED" : "❌ MISSING",
    token_length: process.env.PAGE_ACCESS_TOKEN?.length || 0,
    starts_with: process.env.PAGE_ACCESS_TOKEN?.substring(0, 6) || "none"
  });
}
