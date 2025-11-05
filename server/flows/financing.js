// server/flows/financing.js
// Phase 3 — FINANCING FLOW (Final Locked)
// Entry assumption: a unit has been chosen in Phase 2 and stored in state.selectedUnit

import { allImages, cityProv, peso } from "../lib/format.js";

// ----------------- Helpers -----------------

function norm(s = "") {
  return (s || "").toString().trim();
}

function phNow() {
  const dt = new Date();
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
  return {
    hour: Number(parts.hour || 0),
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function parsePhone(text = "") {
  const m = text.replace(/\s+/g, "").match(/(?:\+?63|0)9\d{9}/);
  return m ? m[0] : null;
}

function parseName(text = "") {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const words = cleaned.split(" ");
  const alpha = /^[A-Za-zÀ-ÿ'.-]+$/;
  const validWords = words.filter((w) => alpha.test(w));
  if (validWords.length >= 2) return validWords.slice(0, 4).join(" ");
  return null;
}

function unitAddress(u = {}) {
  return (
    norm(u.complete_address) ||
    "Showroom address will be sent after we confirm your viewing slot."
  );
}

function unitTitle(u = {}) {
  const y = norm(u.year);
  return [y, u.brand, u.model, u.variant].filter(Boolean).join(" ") || "Selected unit";
}

function ensureFinFlow(state = {}) {
  if (!state.finFlow) state.finFlow = {};
  return state.finFlow;
}

function financingEstimates(u = {}, bud) {
  const srp = Number(u.srp || 0);
  const dpLow = Math.round(srp * 0.25);
  const dpHigh = Math.round(srp * 0.35);
  const monthly2 = Math.round(((srp - dpLow) * 1.3) / 24);
  const monthly3 = Math.round(((srp - dpLow) * 1.35) / 36);
  const monthly4 = Math.round(((srp - dpLow) * 1.4) / 48);
  return {
    dpRange: `${peso(dpLow)}–${peso(dpHigh)}`,
    m2: peso(monthly2),
    m3: peso(monthly3),
    m4: peso(monthly4),
  };
}

// ----------------- Main Flow -----------------

export async function handleFinancingFlow({ ctx, replies, newState, text }) {
  const { sendImages } = ctx;
  const say = (t) => replies.push({ type: "text", text: t });

  const u = newState.selectedUnit || newState._selectedUnit;
  if (!u) {
    say("Paki-pili muna ng unit sa list. Sabihin mo lang “Unit 1” or “Unit 2” para maipakita ko ang full photos. 🙂");
    newState.phase = "phase2";
    return { replies, newState };
  }

  const ff = ensureFinFlow(newState);

  // 1) Photos once
  if (!ff._photosSent) {
    const imgs = allImages(u);
    if (imgs.length > 0) {
      replies.push({ type: "images", urls: imgs });
    }
    say(`Here are the photos of ${unitTitle(u)}. 👍`);
    ff._photosSent = true;
  }

  // 2) Schedule Viewing (same logic as cash)
  const { hour } = phNow();
  const canOfferToday = hour >= 6 && hour <= 15;
  const scheduleLocked = !!ff.schedule_locked;

  if (!scheduleLocked) {
    if (!ff._askedSchedule) {
      if (canOfferToday) {
        say("Available ka ba for unit viewing today or tomorrow? Mas mabilis mag-decide pag nakita mo in person. 😊");
      } else {
        say("Let’s set your viewing — tomorrow or pick a date that works for you. Mas ok pag actual mo makita.");
      }
      ff._askedSchedule = true;
      return { replies, newState };
    }

    if (/today|mamaya|ngayon/i.test(text) && canOfferToday) {
      ff.schedule_date = "today";
    } else if (/tomorrow|bukas/i.test(text)) {
      ff.schedule_date = "tomorrow";
    } else if (/(\d{1,2})\s*(am|pm)/i.test(text)) {
      ff.schedule_time = text.match(/(\d{1,2})\s*(am|pm)/i)[0];
    } else if (/(\d{1,2}:\d{2})\s*(am|pm)?/i.test(text)) {
      ff.schedule_time = text.match(/(\d{1,2}:\d{2}\s*(?:am|pm)?)/i)[0];
    }

    if (!ff.schedule_date) {
      say("Anong araw mo gustong i-view? Today kung kaya, or tomorrow? Pwede ka rin pumili ng specific date.");
      return { replies, newState };
    }
    if (!ff.schedule_time) {
      say("Noted! Anong preferred time mo? (e.g., 10am, 2:30pm)");
      return { replies, newState };
    }

    ff.schedule_locked = true;
    say(`✅ Viewing locked for **${ff.schedule_date} @ ${ff.schedule_time}**.`);
  }

  // 3) Contact Before Address
  if (!ff.mobile || !ff.full_name) {
    const phone = parsePhone(text);
    const name = parseName(text);
    if (phone && !ff.mobile) ff.mobile = phone;
    if (name && !ff.full_name) ff.full_name = name;

    if (!ff.full_name && !ff.mobile) {
      say("Para ma-confirm ko yung slot at ma-prepare yung unit, paki-send ng **full name + mobile number** (required by showroom).");
      return { replies, newState };
    }
    if (!ff.full_name) {
      say("Got it sa number ✅ Ano po ang full name ninyo para ma-list ko sa schedule?");
      return { replies, newState };
    }
    if (!ff.mobile) {
      say("Thanks! Ano naman po ang mobile number ninyo? (09xxxxxxxxx or +639xxxxxxxxx)");
      return { replies, newState };
    }
  }

  // 4) Address Reveal
  if (!ff._addressSent) {
    const addr = unitAddress(u);
    say("✅ Got it! Your viewing is confirmed. Here’s the full location 👇");
    say(addr);
    const loc = cityProv(u);
    if (loc) say(`(Area: ${loc})`);
    say("Message mo lang ako if you need directions ha. 🙂");
    ff._addressSent = true;

    // Store lead shell
    newState.lead = {
      psid: ctx.psid,
      plan: "financing",
      full_name: ff.full_name,
      mobile: ff.mobile,
      sku: norm(u.SKU) || "",
      title: unitTitle(u),
      srp: u.srp ? peso(u.srp) : "",
      city: norm(u.city),
      province: norm(u.province),
      scheduled_date: ff.schedule_date,
      scheduled_time: ff.schedule_time,
      status: "scheduled - financing",
      ts: Date.now(),
    };

    // Transition to financing logic
    ff._inFinancing = true;
    return { replies, newState };
  }

  // 5) Financing Questions: Source of Income
  if (!ff.income_type) {
    if (!ff._askedIncome) {
      say("Since financing tayo — may I ask, ano po ang source of income ninyo? Employed? Business? OFW / Seaman?");
      ff._askedIncome = true;
      return { replies, newState };
    }

    const lower = text.toLowerCase();
    if (/employ|sahod|work/.test(lower)) {
      ff.income_type = "employed";
    } else if (/business|self/.test(lower)) {
      ff.income_type = "business";
    } else if (/ofw|seaman/.test(lower)) {
      ff.income_type = "ofw";
    } else if (/receiver|padala/.test(lower)) {
      ff.income_type = "receiver";
    } else {
      say("Got it. Just to confirm, employed, business owner, OFW/Seaman, or remittance receiver?");
      return { replies, newState };
    }

    say("✅ Noted. Let me show you an estimated computation based on this unit…");
  }

  // 6) Show Financing Estimates
  if (!ff._sentEstimates) {
    const est = financingEstimates(u);
    say(`**Estimated All-In DP:** ${est.dpRange}\n**Monthly (2yrs):** ${est.m2}\n**Monthly (3yrs):** ${est.m3}\n**Monthly (4yrs):** ${est.m4}`);
    say("Estimated lang po ito — final depends sa income documents. Ilang years nyo plan hulugan?");
    ff._sentEstimates = true;
    return { replies, newState };
  }

  // Parse tenor input
  if (!ff.term_years) {
    if (/2/.test(text)) ff.term_years = 2;
    if (/3/.test(text)) ff.term_years = 3;
    if (/4/.test(text)) ff.term_years = 4;

    if (!ff.term_years) {
      say("Quick one lang — 2, 3, or 4 years ang plan nyo?");
      return { replies, newState };
    }

    say(`✅ Sige, ${ff.term_years}-year plan. Now let’s prep your requirements so we can pre-approve habang naka-schedule ka.`);
  }

  // 7) Document Request per type
  if (!ff._askedDocs) {
    switch (ff.income_type) {
      case "employed":
        say("Employed po kayo? May COE na ba kayo or magrerequest pa lang? Pwede nyo isend dito payslip or COE + valid ID anytime so we can start pre-approval.");
        break;
      case "business":
        say("Business owner — ano nature ng business? May DTI or permit ba? Send nyo lang DTI/Permit + 3-month bank statement or receipts + valid ID.");
        break;
      case "ofw":
        say("OFW/Seaman? Pwede nyo isend passport/seaman book, contract, remittance proof + valid ID para ma-pre approve.");
        break;
      case "receiver":
        say("Remittance receiver? Kahit remittance proof + valid ID muna is okay to start pre-approval.");
        break;
      default:
        say("You can send any valid ID or proof of income para ma-start natin. 😊");
    }
    ff._askedDocs = true;
    ff._docFollowUpActive = true;
    ff._docFollowUpCount = 0;
    ff._docFollowUpStartTs = Date.now();
    return { replies, newState };
  }

  // 8) Detect document uploads (telegram/messenger attachment)
  if ((ctx.attachments || []).length > 0) {
    ff._docFollowUpActive = false;
    say("Got it! ✅ Our team is now reviewing what you sent. Expect a call so we can fast-track the approval and release of your unit. 🚗💨");
    return { replies, newState };
  }

  // 9) Rebuttal handling
  if (/lower|baba.*dp|mababa.*down/i.test(text)) {
    say("Depende pa yan after approval — minsan nababawasan pa yung cash-out once ma-review profile. Kaya mas maganda if ma-send nyo yung ID or proof of income para ma-check agad.");
    return { replies, newState };
  }
  if (/skip view|direct approval|diretsong approve/i.test(text)) {
    say("Pwede po yes — kung gusto nyo diretsong approval, send nyo lang yung basic documents dito and we can start pre-screening kahit wala pang viewing.");
    return { replies, newState };
  }

  // 10) If waiting on docs, keep dialog light
  if (ff._docFollowUpActive) {
    say("Whenever you're ready, send nyo lang kahit ID muna so we can proceed. 🙂");
    return { replies, newState };
  }

  // Gentle close
  say("If you have any questions about financing or requirements, just message me. Happy to assist! 👍");
  return { replies, newState };
}

export default { handleFinancingFlow };
