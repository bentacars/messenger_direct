// server/flows/cash.js
// Phase 3 — CASH FLOW (Final Locked)
// Entry assumption: a unit has been chosen in Phase 2 and stored in state.selectedUnit

import { allImages, cityProv, peso } from "../lib/format.js";

// ----------------- Helpers -----------------

function norm(s = "") {
  return (s || "").toString().trim();
}

function phNow() {
  // Get PH local time safely
  const dt = new Date();
  // Derive "hour" by formatting to Asia/Manila
  const parts = new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    hour: "2-digit",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(dt)
    .reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
  // Return useful fields
  return {
    hour: Number(parts.hour || 0), // 0-23
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function parsePhone(text = "") {
  const m = text.replace(/\s+/g, "").match(/(?:\+?63|0)9\d{9}/);
  return m ? m[0] : null;
}

function parseName(text = "") {
  // Very light heuristic: 2+ words, letters only
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const words = cleaned.split(" ");
  const alpha = /^[A-Za-zÀ-ÿ'.-]+$/;
  const validWords = words.filter((w) => alpha.test(w));
  if (validWords.length >= 2) return validWords.slice(0, 4).join(" ");
  return null;
}

function unitAddress(u = {}) {
  // Prefer complete address if available
  if (norm(u.complete_address)) return u.complete_address;
  const loc = cityProv(u);
  return loc || "Showroom address will be sent after we confirm your viewing slot.";
}

function unitTitle(u = {}) {
  const y = norm(u.year);
  const name = [y, u.brand, u.model, u.variant].filter(Boolean).join(" ");
  return name || "Selected unit";
}

function ensureCashFlow(state = {}) {
  if (!state.cashFlow) state.cashFlow = {};
  return state.cashFlow;
}

// ----------------- Main Flow -----------------

export async function handleCashFlow({ ctx, replies, newState, text }) {
  const { sendImages, sendText } = ctx;
  const say = (t) => replies.push({ type: "text", text: t });

  const u = newState.selectedUnit || newState._selectedUnit; // tolerate either key
  if (!u) {
    say("Paki-pili muna ng unit sa list. Sabihin mo lang “Unit 1” or “Unit 2” para maipakita ko ang full photos. 🙂");
    newState.phase = "phase2";
    return { replies, newState };
  }

  // 1) Photos (once)
  const cf = ensureCashFlow(newState);
  if (!cf._photosSent) {
    const imgs = allImages(u);
    if (imgs.length > 0) {
      // Send as sequential images (Messenger generic carousel requires a structured payload; we keep it simple & robust)
      replies.push({ type: "images", urls: imgs });
    }
    // Short human selling hook already shown in Phase 2; keep copy minimal here
    say(`Here are the photos of ${unitTitle(u)}. 👍`);

    cf._photosSent = true;
    // Fall through to scheduling prompt after images
  }

  // 2) Scheduling (time-based rule)
  const { hour } = phNow();
  const canOfferToday = hour >= 6 && hour <= 15; // 6:00–15:59
  const scheduleLocked = !!cf.schedule_locked;

  if (!scheduleLocked) {
    if (!cf._askedSchedule) {
      if (canOfferToday) {
        say("Available ka ba for unit viewing today or tomorrow? Mas mabilis mag-decide pag nakita mo in person. 😊");
      } else {
        say("Let’s set your viewing — tomorrow or pick a date that works for you. Mas ok pag actual mo makita.");
      }
      cf._askedSchedule = true;
      return { replies, newState };
    }

    // Try to detect date/time intents (very simple; you can enhance later or use LLM NLU)
    if (/today|mamaya|ngayon/i.test(text) && canOfferToday) {
      cf.schedule_date = "today";
    } else if (/tomorrow|bukas/i.test(text)) {
      cf.schedule_date = "tomorrow";
    } else if (/(\d{1,2})\s*(am|pm)/i.test(text)) {
      cf.schedule_time = text.match(/(\d{1,2})\s*(am|pm)/i)[0];
    } else if (/(\d{1,2}):(\d{2})\s*(am|pm)?/i.test(text)) {
      cf.schedule_time = text.match(/(\d{1,2}:\d{2}\s*(?:am|pm)?)/i)[0];
    }

    if (!cf.schedule_date) {
      // Ask for day
      say("Anong araw mo gustong i-view? Today kung kaya, or tomorrow? Pwede ka rin pumili ng specific date.");
      return { replies, newState };
    }
    if (!cf.schedule_time) {
      say("Noted! Anong preferred time mo? (e.g., 10am, 2:30pm)");
      return { replies, newState };
    }

    // Once we have both, lock schedule
    cf.schedule_locked = true;
    say(`✅ Noted. I’ll lock your viewing for **${cf.schedule_date} @ ${cf.schedule_time}**.`);
  }

  // 3) Contact Info BEFORE Address
  if (!cf.mobile || !cf.full_name) {
    const phone = parsePhone(text);
    const name = parseName(text);

    if (phone && !cf.mobile) cf.mobile = phone;
    if (name && !cf.full_name) cf.full_name = name;

    if (!cf.full_name && !cf.mobile) {
      say("Para ma-confirm ko yung slot at ma-prepare yung unit, paki-send ng **full name + mobile number** (required by showroom).");
      say("Format example: *Juan Dela Cruz, 09171234567*");
      return { replies, newState };
    }
    if (!cf.full_name) {
      say("Got it sa number ✅ Ano po ang full name ninyo para ma-list ko sa schedule?");
      return { replies, newState };
    }
    if (!cf.mobile) {
      say("Thanks! Ano naman po ang mobile number ninyo? (09xxxxxxxxx or +639xxxxxxxxx)");
      return { replies, newState };
    }
  }

  // 4) If user requests address before contact, we would’ve blocked above already.
  // Here, both name + number are present:
  if (!cf._addressSent) {
    const addr = unitAddress(u);
    say("✅ Got it! Your viewing is confirmed. Here’s the full location 👇");
    say(addr);
    const loc = cityProv(u);
    if (loc) say(`(Area: ${loc})`);
    say("Message mo lang ako if you need directions ha. 🙂");

    // Lead log fields (kept in state for now; you can POST to your lead sheet later)
    newState.lead = {
      psid: ctx.psid,
      plan: "cash",
      full_name: cf.full_name,
      mobile: cf.mobile,
      sku: norm(u.SKU) || "",
      title: unitTitle(u),
      srp: u.srp ? peso(u.srp) : "",
      city: norm(u.city),
      province: norm(u.province),
      scheduled_date: cf.schedule_date,
      scheduled_time: cf.schedule_time,
      status: "scheduled - cash",
      ts: Date.now(),
    };

    cf._addressSent = true;
    return { replies, newState };
  }

  // 5) Keep conversational loop minimal after address
  if (/resched|re-sched|iba oras|baguhin/i.test(text)) {
    cf.schedule_locked = false;
    cf.schedule_date = null;
    cf.schedule_time = null;
    cf._askedSchedule = false;
    say("No problem! Sabihin mo lang yung bagong day & time mo. 🙂");
    return { replies, newState };
  }

  // Default gentle close
  say("If you have any questions before viewing, just message me. Happy to help. 👍");
  return { replies, newState };
}

export default { handleCashFlow };
