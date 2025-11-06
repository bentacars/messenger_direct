// /api/debug-imports.js
export const config = { runtime: "nodejs" };

export default async function handler(_req, res) {
  const mods = [
    "../server/lib/ai.js",
    "../server/lib/session.js",
    "../server/lib/messenger.js",
    "../server/lib/interrupts.js",
    "../server/flows/qualifier.js",
    "../server/flows/offers.js",
    "../server/flows/cash.js",
    "../server/flows/financing.js",
    "../server/flows/router.js",
    "../server/lib/nudges.js",
  ];

  const results = [];
  for (const m of mods) {
    try {
      await import(m);
      results.push({ module: m, ok: true });
    } catch (e) {
      results.push({ module: m, ok: false, error: String(e && e.message || e) });
      return res.status(200).json({ results, failed: m });
    }
  }
  return res.status(200).json({ results, failed: null });
}
