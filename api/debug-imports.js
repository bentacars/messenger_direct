// /api/debug-imports.js
export const config = { runtime: "nodejs" };

import * as ai from "../server/lib/ai.js";
import * as interrupts from "../server/lib/interrupts.js";
import * as messenger from "../server/lib/messenger.js";
import * as qualifier from "../server/flows/qualifier.js";
import * as router from "../server/flows/router.js";
import * as cash from "../server/flows/cash.js";
import * as financing from "../server/flows/financing.js";
import * as nudges from "../server/lib/nudges.js";

export default async function handler(_req, res) {
  const shape = (m) => (m ? Object.keys(m) : []);
  const results = [
    { module: "../server/lib/ai.js",          ok: true, keys: shape(ai) },
    { module: "../server/lib/interrupts.js",  ok: true, keys: shape(interrupts) },
    { module: "../server/lib/messenger.js",   ok: true, keys: shape(messenger) },
    { module: "../server/flows/qualifier.js", ok: true, keys: shape(qualifier) },
    { module: "../server/flows/router.js",    ok: true, keys: shape(router) },
    { module: "../server/flows/cash.js",      ok: true, keys: shape(cash) },
    { module: "../server/flows/financing.js", ok: true, keys: shape(financing) },
    { module: "../server/lib/nudges.js",      ok: true, keys: shape(nudges) },
  ];

  // Extra hints about router interop
  results.push({
    module: "router export hints",
    ok: true,
    note: `router: ${typeof router.router}, default: ${typeof router.default}, keys: ${shape(router).join(",")}`,
  });

  return res.status(200).json({ results, failed: 0 });
}
