// /api/debug-imports.js
export const config = { runtime: "nodejs" };

/** ESM-safe dynamic import using file URLs */
async function probe(relPath) {
  try {
    const url = new URL(relPath, import.meta.url); // file:///var/task/...
    const mod = await import(url.href);
    return { module: relPath, ok: true, keys: Object.keys(mod) };
  } catch (e) {
    return {
      module: relPath,
      ok: false,
      error: String(e?.message || e),
      stack: (e?.stack || "").split("\n").slice(0, 3).join(" | ")
    };
  }
}

export default async function handler(req, res) {
  const list = [
    "../server/lib/ai.js",
    "../server/lib/interrupts.js",
    "../server/lib/messenger.js",
    "../server/flows/qualifier.js",
    "../server/flows/router.js",
    "../server/flows/cash.js",
    "../server/flows/financing.js",
    "../server/lib/nudges.js"
  ];

  const results = [];
  for (const m of list) results.push(await probe(m));

  const routerProbe = await probe("../server/flows/router.js");
  results.push({ module: "router exports", ok: routerProbe.ok, keys: routerProbe.keys });

  res.status(200).json({ results, failed: results.filter(r => !r.ok).length });
}
