// api/debug-list.js
export const config = { runtime: "nodejs" };

import { readdir } from "node:fs/promises";
import { join } from "node:path";

export default async function handler(req, res) {
  try {
    const libDir = join(process.cwd(), "server", "lib");
    let files = [];
    try {
      files = await readdir(libDir);
    } catch (e) {
      return res.status(200).json({ cwd: process.cwd(), note: "server/lib not found", error: String(e) });
    }
    return res.status(200).json({ cwd: process.cwd(), "server/lib": files });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
