// server/flows/router.js
import { sendText } from "../lib/messenger.js";
import { getSession, saveSession } from "../lib/session.js";

// Optional: if you have ai.js, we'll use it for nicer one-liners.
// If not found, we fallback to static prompts.
let AI = null;
try { ({ AI } = await import("../lib/ai.js")); } catch { /* fallback mode */ }

const INVENTORY_API_URL = process.env.INVENTORY_API_URL;

// Required fields in R3 (Hybrid): payment, budget, location, trans, body
const REQUIRED = ["payment", "budget", "location", "trans", "body"];

// --- Helpers: extraction (regex-based; AI complements tone, not parsing) ---
function extractQualifiers(q, text) {
  const t = (text || "").toLowerCase();

  // payment
  if (!q.payment) {
    if (/\b(cash|spot|full)\b/.test(t)) q.payment = "cash";
    else if (/\b(hulog|hulugan|financ|loan|all[- ]?in|dp)\b/.test(t)) q.payment = "financing";
  }
  // budget
  if (!q.budget) {
    const m = t.replace(/[,₱\s]/g, "").match(/(\d{2,7})(k|000)?/i);
    if (m) {
      let v = Number(m[1]);
      if (m[2]) v *= 1000;
      q.budget = String(v);
    }
  }
  // location
  if (!q.location) {
    const m = t.match(/\b(qc|quezon|manila|pasig|makati|taguig|mandaluyong|pasay|caloocan|valenzuela|marikina|parañaque|las piñas|cavite|laguna|bulacan|pampanga|cebu|davao|iloilo|bacolod|rizal)\b/);
    if (m) q.location = m[0].trim();
  }
  // trans
  if (!q.trans) {
    if (/\b(at|automatic|a\/t)\b/.test(t)) q.trans = "automatic";
    else if (/\b(mt|manual)\b/.test(t)) q.trans = "manual";
    else if (/\b(any|kahit ano)\b/.test(t)) q.trans = "any";
  }
  // body
  if (!q.body) {
    if (/\bsedan\b/.test(t)) q.body = "sedan";
    else if (/\b(suv|mpv)\b/.test(t)) q.body = "suv/mpv";
    else if (/\b(van|pickup|pick[- ]?up)\b/.test(t)) q.body = "van/pickup";
    else if (/\bhatch\b/.test(t)) q.body = "hatchback";
    else if (/\b(any|kahit ano)\b/.test(t)) q.body = "any";
  }

  // preferences (optional)
  q.pref = q.pref || {};
  const brandHit = t.match(/\b(toyota|mitsubishi|honda|nissan|suzuki|hyundai|ford|kia|mazda)\b/);
  if (brandHit) q.pref.brand = brandHit[0];
  const modelHit = t.match(/\b(vios|mirage|city|civic|wigo|brio|innova|fortuner|everest|altis|terra|xpander)\b/);
  if (modelHit) q.pref.model = modelHit[0];
  const yearHit = t.match(/\b(20\d{2}|19\d{2})\b/);
  if (yearHit) q.pref.year = yearHit[0];

  return q;
}

function missingKey(q) {
  for (const k of REQUIRED) if (!q[k]) return k;
  return "";
}

function peso(n) {
  const v = Number(n || 0);
  return "₱" + v.toLocaleString("en-PH");
}

function hookByModel(model = "") {
  const m = model.toLowerCase();
  if (m.includes("mirage")) return "3-cyl → super tipid sa gas ✅";
  if (m.includes("vios")) return "Matipid, mura maintenance, pang-grab ✅";
  if (m.includes("innova")) return "7-seater, pang pamilya, diesel tipid ✅";
  return "Parts are easy to find ✅";
}

function caption(u, payment) {
  const title = `${u.year || ""} ${u.brand || ""} ${u.model || ""} ${u.variant || ""}`.replace(/\s+/g, " ").trim();
  const km = u.mileage ? `${Number(u.mileage).toLocaleString("en-PH")} km — ` : "";
  const loc = `${u.city || ""}${u.city && u.province ? ", " : ""}${u.province || ""}`.trim();
  const priceLine = payment === "cash"
    ? `SRP: ${peso(u.srp)} (negotiable upon viewing)`
    : `All-in: ${peso(u.all_in || u.allIn)} (subject for approval)`;
  return `${title}\n${km}${loc}\n${priceLine}\n${hookByModel(u.model || "")}`;
}

function withinCash(unit, budget) {
  if (!budget) return true;
  const srp = Number(unit.srp || unit.SRP || 0);
  return Math.abs(srp - Number(budget)) <= 50000;
}
function withinFin(unit, budget) {
  if (!budget) return true;
  const ai = Number(unit.all_in || unit.allin || unit.allIn || 0);
  return ai <= (Number(budget) + 50000);
}

// --- Core route ---
export default async function route({ psid, text, payload }) {
  const messages = [];
  let session = (await getSession(psid)) || { pid: psid, funnel: { qual: {} }, offers: {} };
  session.funnel = session.funnel || {};
  session.funnel.qual = session.funnel.qual || { pref: {} };
  session.offers = session.offers || { pool: [], page: 0 };

  // keep idle fresh
  await saveSession(psid, { lastInteractionAt: Date.now() });

  // Start over
  if (/^start\s*over$/i.test(text) || payload === "START_OVER" || payload === "RESTART") {
    session = { pid: psid, funnel: { qual: {} }, offers: { pool: [], page: 0 }, paused: false, nudgeLevel: 0 };
    await saveSession(psid, session);
    messages.push({ type: "text", text: "Fresh start tayo. 👍" });
  }

  // Resume (button)
  if (payload === "RESUME" || payload === "RESUME_CONTINUE") {
    await saveSession(psid, { paused: false });
    messages.push({ type: "text", text: "Game, itutuloy natin kung saan tayo huli." });
  }

  // Handle offer postbacks
  if (payload && /^CHOOSE_/.test(payload)) {
    const sku = payload.replace(/^CHOOSE_/, "");
    const chosen = session.offers.pool.find(u => String(u.SKU || u.sku || u.id || "") === sku);
    if (chosen) {
      messages.push({ type: "text", text: "Solid choice! 🔥 Sending full photos…" });
      const imgs = [
        chosen.image_1, chosen.image_2, chosen.image_3, chosen.image_4, chosen.image_5,
        chosen.image_6, chosen.image_7, chosen.image_8, chosen.image_9, chosen.image_10
      ].filter(Boolean);
      if (imgs.length >= 2) {
        const cards = imgs.slice(0, 10).map(url => ({ title: "", subtitle: "", image_url: url, buttons: [] }));
        messages.push({ type: "carousel", cards });
      } else {
        for (const url of imgs) messages.push({ type: "image", url });
      }
      return { messages };
    }
  }
  if (payload === "SHOW_OTHERS" || /others/i.test(text)) {
    const left = session.offers.pool.slice(2);
    if (left.length) {
      const q = session.funnel.qual;
      for (const u of left) {
        if (u.image_1) messages.push({ type: "image", url: u.image_1 });
        messages.push({
          type: "buttons",
          text: caption(u, q.payment),
          buttons: [
            { title: "Choose", payload: `CHOOSE_${u.SKU || u.sku || u.id || "X"}` }
          ]
        });
      }
      return { messages };
    }
    messages.push({ type: "text", text: "Gusto mo bang i-widen ko yung search? Pwede kong i-adjust ang body type o price range konti." });
    messages.push({
      type: "buttons",
      text: "Pili:",
      buttons: [
        { title: "Widen search ✅", payload: "WIDEN" },
        { title: "Keep as is ❌", payload: "KEEP" }
      ]
    });
    return { messages };
  }

  // Qualify (R3 Hybrid): extract from any free text
  if (text) {
    session.funnel.qual = extractQualifiers(session.funnel.qual, text);
    await saveSession(psid, session);
  }

  // Ask only what's missing, in a friendly way
  const miss = missingKey(session.funnel.qual);
  if (miss) {
    let line = "";
    switch (miss) {
      case "payment": line = "Pwede tayo either cash or hulugan. Anong mas prefer mo?"; break;
      case "budget":  line = (session.funnel.qual.payment === "cash")
        ? "Para hindi ako lumampas, mga magkano cash budget mo? (ex: 550k)"
        : "Magkano target cash-out/all-in mo? (ex: 95k all-in)";
        break;
      case "location": line = "Nationwide tayo — saan ka based (city/province) para mahanap ko yung pinakamalapit?"; break;
      case "trans": line = "Marunong ka ba mag-manual o AT lang — or ok lang any?"; break;
      case "body": line = "5-seater or 7+ seater ba? Or sedan, hatchback, MPV/SUV, van/pickup — alin ang hanap mo?"; break;
    }
    // If AI exists, polish the line
    if (AI) line = await AI.oneLiner(line, {});
    messages.push({ type: "text", text: line });
    return { messages };
  }

  // Summarize + match
  const q = session.funnel.qual;
  const summary = `Okay, ito yung hahanapin ko for you:
• ${q.payment === "financing" ? "Financing" : "Cash"}
• Budget ~ ${peso(q.budget)}
• Location: ${q.location?.toUpperCase()}
• Trans: ${(q.trans || "").toUpperCase()}
• Body: ${(q.body || "").toUpperCase()}
Saglit, I’ll pull the best units that fit this. 🔎`;
  messages.push({ type: "text", text: AI ? await AI.oneLiner(summary, {}) : summary });
  messages.push({ type: "typing", on: true });

  // Fetch inventory + pick top 4 (Priority → OK to Market) with price rules
  let data = [];
  try {
    const r = await fetch(INVENTORY_API_URL);
    data = await r.json();
  } catch (e) {
    console.error("inventory fetch error", e);
  }
  const rows = Array.isArray(data) ? data : (data.rows || []);

  // Filter by payment rule
  const filtered = rows.filter(u => {
    if (q.payment === "cash") return withinCash(u, q.budget);
    return withinFin(u, q.budget);
  });

  // Strong prefs
  const byPrefs = filtered.filter(u => {
    if (q.pref?.brand && String(u.brand || "").toLowerCase() !== q.pref.brand.toLowerCase()) return false;
    if (q.pref?.model && String(u.model || "").toLowerCase() !== q.pref.model.toLowerCase()) return false;
    if (q.pref?.year && String(u.year || "") !== String(q.pref.year)) return false;
    return true;
  });

  // Tier: Priority first, then OK to Market
  const pri = (byPrefs.length ? byPrefs : filtered).filter(u => String(u.price_status || "").toLowerCase().includes("priority"));
  const okm = (byPrefs.length ? byPrefs : filtered).filter(u => /ok.*market/i.test(String(u.price_status || "")));

  const pool = [...pri, ...okm].slice(0, 4);
  session.offers.pool = pool;
  session.offers.page = 1;
  await saveSession(psid, session);

  messages.push({ type: "typing", on: false });

  if (!pool.length) {
    messages.push({ type: "text", text: "Walang exact match sa filters na ’to. Pwede kitang i-tryhan ng alternatives — type mo “Others”." });
    return { messages };
  }

  // show 2 first
  for (const u of pool.slice(0, 2)) {
    if (u.image_1) messages.push({ type: "image", url: u.image_1 });
    messages.push({
      type: "buttons",
      text: caption(u, q.payment),
      buttons: [
        { title: "Choose", payload: `CHOOSE_${u.SKU || u.sku || u.id || "X"}` },
        { title: "Others", payload: "SHOW_OTHERS" },
        { title: "Photos", payload: `CHOOSE_${u.SKU || u.sku || u.id || "X"}` }
      ]
    });
  }

  return { messages };
}
