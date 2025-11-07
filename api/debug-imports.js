// api/debug-imports.js
export const config = { runtime: "nodejs" };

const MODULES = [
  "../server/lib/ai.js",
  "../server/lib/interrupts.js",
  "../server/lib/messenger.js",
  "../server/flows/qualifier.js",
  "../server/flows/router.js",
  "../server/flows/cash.js",
  "../server/flows/financing.js",
  "../server/lib/nudges.js",
  "router exports" // sanity check after dynamic import
];

export default async function handler(req, res) {
  const results = [];

  for (const id of MODULES) {
    try {
      if (id === "router exports") {
        const r = await import("../server/flows/router.js");
        results.push({ module: "router exports", ok: true, keys: Object.keys(r) });
        continue;
      }
      const mod = await import(id);
      results.push({ module: id, ok: true, keys: Object.keys(mod) });
    } catch (err) {
      results.push({
        module: id,
        ok: false,
        error: String(err?.message || err),
        stack: String(err?.stack || "")
      });
    }
  }

  res.status(200).json({ results, failed: results.filter(r => !r.ok).length });
}
