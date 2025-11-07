// api/debug-imports.js
export const config = { runtime: "nodejs" };

async function probe(path) {
  try {
    const m = await import(path);
    const keys = Object.keys(m);
    return { module: path, ok: true, keys };
  } catch (e) {
    return {
      module: path,
      ok: false,
      error: String(e?.message || e),
      stack: e?.stack?.split("\n").slice(0, 4).join(" | "),
    };
  }
}

export default async function handler(req, res) {
  const base = "../server";
  const mods = [
    `${base}/lib/ai.js`,
    `${base}/lib/interrupts.js`,
    `${base}/lib/messenger.js`,
    `${base}/flows/qualifier.js`,
    `${base}/flows/router.js`,
    `${base}/flows/cash.js`,
    `${base}/flows/financing.js`,
    `${base}/lib/nudges.js`,
  ];
  const results = [];
  for (const m of mods) results.push(await probe(m));

  // also verify the router exports specifically
  const r = await probe(`${base}/flows/router.js`);
  results.push({ module: "router exports", ok: r.ok, keys: r.keys });

  res.status(200).json({ results, failed: results.filter(x => !x.ok).length });
}
