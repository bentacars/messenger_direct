// /api/debug-imports.js
export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  const mods = [
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
  for (const m of mods) {
    try {
      // dynamic import so we can catch module-level errors cleanly
      const mod = await import(m);
      results.push({
        module: m,
        ok: true,
        keys: Object.keys(mod || {}),
        // if router is CJS-shaped, surface its shape to verify
        note:
          m.includes("/router.js") && mod
            ? `router: ${typeof mod.router}, default: ${typeof mod.default}`
            : undefined,
      });
    } catch (e) {
      results.push({
        module: m,
        ok: false,
        error: String(e && e.message),
        stack:
          e && e.stack
            ? e.stack.split("\n").slice(0, 3).join(" | ")
            : undefined,
      });
    }
  }

  return res.status(200).json({
    results,
    failed: results.filter((r) => !r.ok).length,
  });
}
