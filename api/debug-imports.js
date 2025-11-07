// api/debug-imports.js
export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  const modules = [
    "../server/lib/ai.js",
    "../server/lib/interrupts.js",
    "../server/lib/messenger.js",
    "../server/flows/qualifier.js",
    "../server/flows/router.js",
    "../server/flows/cash.js",
    "../server/flows/financing.js",
    "../server/lib/nudges.js",
  ];

  const results = [];
  for (const m of modules) {
    try {
      const mod = await import(m);
      results.push({ module: m, ok: true, keys: Object.keys(mod) });
    } catch (e) {
      results.push({ module: m, ok: false, error: String(e).split("\n")[0] });
    }
  }

  // Extra check: does router expose a callable "route"?
  try {
    const r = await import("../server/flows/router.js");
    const route = r.route || r.router || r.default;
    results.push({
      module: "router exports",
      ok: typeof route === "function",
      keys: Object.keys(r),
    });
  } catch (e) {
    results.push({ module: "router exports", ok: false, error: String(e).split("\n")[0] });
  }

  return res.status(200).json({ results, failed: results.filter(r => !r.ok).length });
}
