// server/lib/interrupts.js
// Phase 4 — FAQ / Rebuttal / Off-Flow Intelligence
// Detects interrupts (FAQ, objection, small-talk) and returns:
//   { reply: string, resume?: string }  OR null if no interrupt
//
// It never mutates state (router handles saving). Keep outputs pure JSON.

import { missingFields } from "../flows/qualifier.js";

// ---- utilities -------------------------------------------------

function norm(s = "") {
  return (s || "").toString().trim();
}
function lc(s = "") {
  return norm(s).toLowerCase();
}

// Build a short, human resume line based on state & phase
function resumeLine(state = {}) {
  const phase = state.phase || "phase1";
  if (phase === "phase1") {
    const miss = missingFields(state.qualifier || []);
    if (miss.length > 0) {
      // Ask only one, the next missing
      const next = miss[0];
      switch (next) {
        case "payment":
          return "Sige, quick one lang — cash or financing ang plan mo?";
        case "budget":
          return "Noted. Magkano target budget mo? (SRP kung cash, or cash-out kung financing)";
        case "location":
          return "Saan location mo (city/province) para ma-match ko sa pinakamalapit na showroom?";
        case "transmission":
          return "Auto or manual ang prefer mo? (Pwede rin ‘any’)";
        case "bodyType":
          return "5-seater or 7+ seater? Sedan/SUV/MPV/van/pickup — alin ang gusto mo?";
      }
    }
    return "Okay, ready na ko to match units — gusto mo bang ituloy?";
  }

  if (phase === "phase2") {
    return "Balik tayo sa options — alin dito gusto mong i-view? Pwede ka ring sabihin “Others” para sa alternates.";
  }

  if (phase === "cash") {
    const cf = state.cashFlow || {};
    if (!cf.schedule_locked) return "Set natin viewing — today/tomorrow or pick a date that works for you?";
    if (!cf.full_name || !cf.mobile) return "Kindly send full name + mobile so I can confirm your viewing and share the full address.";
    return "May gusto ka bang i-adjust sa schedule or may ibang tanong bago viewing?";
  }

  if (phase === "financing") {
    const ff = state.finFlow || {};
    if (!ff.schedule_locked) return "Set muna natin viewing — today/tomorrow or pick a date?";
    if (!ff.full_name || !ff.mobile) return "Pakisend ng full name + mobile para ma-confirm ko yung viewing and share the address.";
    if (!ff.income_type) return "Since financing tayo — employed, business, OFW/Seaman, or remittance receiver?";
    if (!ff._sentEstimates) return "Send ko muna yung estimates, then pili tayo ng 2/3/4-year plan.";
    if (!ff.term_years) return "Quick one — 2, 3, or 4 years ang plan nyo?";
    if (!ff._askedDocs) return "I-list ko na requirements based on income para ma-pre-approve habang naka-schedule ka.";
    return "Pwede mong isend kahit ID muna para makapagsimula tayo ng pre-approval. 🙂";
  }

  return "Tuloy lang tayo. 🙂";
}

// ---- catalogs --------------------------------------------------

// Short, friendly answers. Keep Taglish, human, and concise.
const CANNED = [
  // Availability
  {
    test: /(available|avail|meron pa|nabibili pa|still.*(available|there))/i,
    reply: "Yes, available pa — pero mabilis nauubos yung magagandang units. 👍",
    cat: "availability",
  },

  // Negotiation / pricing push
  {
    test: /(last price|lowest price|pwede.*(tawad|less|baba).*(price|cash)|baba.*presyo)/i,
    reply: "Negotiable upon actual viewing — depende sa assessment ng condition. Mas madali humingi ng best price pag nakita na in person. 🙂",
    cat: "negotiation",
  },

  // Lower DP / monthly push (financing)
  {
    test: /(lower.*dp|pwede.*lower.*dp|mababa.*down|baba.*cash[- ]?out|taas.*monthly|lower.*monthly)/i,
    reply: "Depende pa yan after approval — minsan nababawasan pa ang cash-out/bumababa monthly once ma-review profile. Best is mag-send ka ng ID/proof of income para ma-check agad.",
    cat: "financing",
  },

  // Trade-in
  {
    test: /(trade[\s-]?in|swap|palit\s*sasakyan)/i,
    reply: "We accept trade-in, depende sa appraisal ng unit. Pwede natin i-assess after viewing para makita actual condition. 🚗🔁",
    cat: "tradein",
  },

  // Location / branches / address (guarded)
  {
    test: /(saan|san|location|branch|address|taga.*saan|nasaan|shop|showroom)/i,
    reply: "May partners tayo nationwide. Full address ibinibigay ko after ma-confirm natin yung viewing slot (standard para ma-prepare agad yung unit pag dating mo). 👍",
    cat: "location",
  },

  // Viewing rules: mechanico, test drive
  {
    test: /(pwede.*mekaniko|dala.*mekaniko|pacheck|check.*mechanic|test drive|testdrive)/i,
    reply: "Pwede magdala ng mekaniko at mag-test drive kapag cleared ng showroom sa viewing. Mas ok talaga pag actual mo makita. 🙂",
    cat: "viewing",
  },

  // Legitimacy / trust
  {
    test: /(legit|totoo ba|scam|katiwala|tiwala|how.*legit)/i,
    reply: "We’re partnered with multiple dealers nationwide and handle buyers daily — maayos ka dito. I-guide kita step-by-step hanggang ma-release ang unit. 🙂",
    cat: "trust",
  },

  // Warranty
  {
    test: /(warranty|waranti|garantiya|guarantee)/i,
    reply: "Varies per unit/dealer. Madalas may post-purchase support; exact coverage i-confirm natin sa viewing para detailed.",
    cat: "warranty",
  },

  // Documents / co-maker / requirements
  {
    test: /(requirements|reqs|dokumento|documents|co[- ]?maker|comaker|valid id|payslip|coe|dti|permit|bank statement)/i,
    reply: "Basic: valid ID; financing: depende sa income (employed: payslip/COE, business: DTI/permit + income proof, OFW/seaman: contract + ID). Pwede mong isend dito para ma-pre-approve.",
    cat: "docs",
  },

  // Process timeline / approval time
  {
    test: /(gaano.*katagal|ilang araw|approval.*(time|tagal)|release|processing time)/i,
    reply: "Fast-track tayo — pre-approval usually mabilis kapag kompleto ang basic docs. Viewing helps finalize things para ma-release agad. 🚗💨",
    cat: "timeline",
  },

  // Insurance
  {
    test: /(insurance|insure|compre|comp.*insurance)/i,
    reply: "Kasama o hiwalay depende sa unit at deal. I-detail natin after viewing para sakto sa pili mong unit.",
    cat: "insurance",
  },

  // Total cost
  {
    test: /(magkano.*lahat|total.*cost|all in.*magkano|overall|out.*the.*door)/i,
    reply: "I-compute natin based sa napiling unit at terms. Kung cash: SRP + transfer/fees; kung financing: cash-out + monthly. I-finalize natin after viewing/pre-approval.",
    cat: "totalcost",
  },

  // Reservation
  {
    test: /(reserve|reservation|pa[- ]?reserve|down.*to.*reserve)/i,
    reply: "Pwede mag-reserve para ma-hold ang unit — depende sa dealer rules. Best after viewing or once decided na, para secured na.",
    cat: "reservation",
  },

  // Delivery
  {
    test: /(deliver|pa[- ]?deliver|ipa[- ]?deliver|door[- ]?to[- ]?door)/i,
    reply: "Delivery is possible depende sa unit at location. I-arrange natin after approval/release para smooth.",
    cat: "delivery",
  },

  // Loan acceptability / no CI
  {
    test: /(no\s*ci|walang\s*ci|pwede.*self[- ]?employed|ofw|seaman|freelancer|commission)/i,
    reply: "Case-to-case, pero maraming profiles na puwede. The sooner makapag-send ka ng basic ID/income proof, mas mabilis natin ma-assess. 🙂",
    cat: "loanpolicy",
  },

  // Unit history
  {
    test: /(flood(ed)?|ondoy|accident|casa|record|mileage.*totoo|history|stolen|hotcar)/i,
    reply: "We verify condition and documents with the dealer. Mas accurate kapag actual viewing/inspection — pwede mo ring dalhin mekaniko mo for peace of mind.",
    cat: "history",
  },

  // Small talk / hours
  {
    test: /(kamusta|kumusta|how are you|open hours|store hours|anong oras)/i,
    reply: "All good! 🙂 Online tayo most of the day; viewing schedules ang ina-arrange natin with the showroom para sure na ma-assist ka pagdating mo.",
    cat: "smalltalk",
  },
];

// ---- main ------------------------------------------------------

export async function handleInterrupts(userText = "", state = {}) {
  const msg = lc(userText);
  if (!msg) return null;

  // Quick exits: explicit continue / start over handled by router
  if (/^(continue|ituloy|resume)\b/i.test(userText)) return null;
  if (/^start over$/i.test(userText)) return null;

  // Scan canned patterns
  for (const item of CANNED) {
    if (item.test.test(userText)) {
      const r = { reply: item.reply };
      // Always try to resume gracefully
      const resume = resumeLine(state);
      if (resume) r.resume = resume;
      return r;
    }
  }

  // No canned match → optional AI fallback (short answer then resume)
  try {
    // Lazy import to avoid hard dependency if LLM is disabled
    const llm = await import("./llm.js").catch(() => null);
    if (llm && typeof llm.aiShortAnswer === "function") {
      const short = await llm.aiShortAnswer({
        question: userText,
        context: {
          phase: state.phase || "phase1",
          hasSchedule:
            !!(state.cashFlow && state.cashFlow.schedule_locked) ||
            !!(state.finFlow && state.finFlow.schedule_locked),
        },
      });
      if (short && short.trim()) {
        return {
          reply: short.trim(),
          resume: resumeLine(state),
        };
      }
    }
  } catch {
    // Silent fallback
  }

  // No interrupt
  return null;
}

export default { handleInterrupts };
