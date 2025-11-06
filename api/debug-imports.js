// /api/debug-imports.js
export const config = { runtime: "nodejs" };

/**
 * ✅ STATIC IMPORTS (forces Vercel to bundle the files)
 *    Without these, Vercel may tree-shake modules and they can't be imported at runtime.
 */
import "../server/lib/ai.js";
import "../server/lib/interrupts.js";
import "../server/lib/messenger.js";
import "../server/flows/qualifier.js";
import "../server/flows/router.js";
import "../server/flows/cash.js";
import "../server/flows/financing.js";
import "../server/lib/nudges.js";

/**
 * ✅ MAIN DEBUG HANDLER
 *    Tries to dynamically import every module and returns an ok/error report.
 */
export default async function handler(req, res) {
  const modulesToTest = [
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

  for (const m of modulesToTest) {
    try {
      await import(m);
      results.push({ module: m, ok: true });
    } catch (err) {
      results.push({
        module: m,
        ok: false,
        error: err?.message || String(err),
      });
    }
  }

  return res.status(200).json({
    results,
    failed: results.filter(r => !r.ok).length,
  });
}
