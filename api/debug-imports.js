// /api/debug-imports.js
export const config = { runtime: "nodejs" };

/** Safely import a module using a file:// URL and report its exported keys. */
async function probe(relPath) {
  try {
    const url = new URL(relPath, import.meta.url);        // resolve to absolute file URL
    const mod = await import(url.href);                   // dynamic import, but explicit path
    return { module: relPath, ok: true, keys: Object.keys(mod) };
  } catch (e) {
    return { module: relPath, ok: false, error: String(e?.message || e) };
  }
}

export default async function handler(_req, res) {
  const targets = [
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
  for (const p of targets) results.push(await probe(p));

  // small hint about router shape (helps webhook import interop)
  try {
    const url = new URL("../server/flows/router.js", import.meta.url);
    const r = await import(url.href);
    results.push({
      module: "router exports",
      ok: true,
      note: `router:${typeof r.router}, default:${typeof r.default}, keys:${Object.keys(r).join(",")}`,
    });
  } catch (e) {
    results.push({ module: "router exports", ok: false, error: String(e?.message || e) });
  }

  const failed = results.filter(r => !r.ok).length;
  res.status(200).json({ results, failed });
}
