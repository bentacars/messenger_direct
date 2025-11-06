// server/flows/router.js
// LLM-first orchestrator: Phase 1 (qualify) → Phase 2 (offers) → Phase 3 (cash/financing flows)

import { askLLM } from "../lib/ai.js";
import { extractQualifiers, missingFields, askForMissingConversational } from "./qualifier.js";
import { matchUnits, formatUnitReply } from "./offers.js";
import { handleCashFlow } from "./cash.js";
import { handleFinancingFlow } from "./financing.js";
import { handleInterrupts } from "../lib/interrupts.js";
import { formatSummary } from "../lib/model.js";

export async function router(ctx) {
  const { text = "", state = {} } = ctx;

  const replies = [];
  const newState = { ...state };

  // Init
  if (!newState.phase) {
    newState.phase = "phase1";
    newState.created_at = Date.now();
  }

  // ---- INTERRUPTS: run only when Phase 1 is COMPLETE ----
  if (newState.phase !== "phase1" || missingFields(newState.qualifier || {}).length === 0) {
    const interrupt = await handleInterrupts(text, newState);
    if (interrupt) {
      replies.push({ type: "text", text: interrupt.reply });
      if (interrupt.resume) replies.push({ type: "text", text: interrupt.resume });
      return { replies, newState };
    }
  }

  // Route by phase
  switch (newState.phase) {
    case "phase1":
      return await phase1({ ctx, text, replies, newState });
    case "phase2":
      return await phase2({ ctx, text, replies, newState });
    case "cash":
      return await handleCashFlow({ ctx, replies, newState, text });
    case "financing":
      return await handleFinancingFlow({ ctx, replies, newState, text });
    default:
      replies.push({ type: "text", text: "Oops, naputol yata. Start ulit tayo?" });
      return { replies, newState: { phase: "phase1", qualifier: {} } };
  }
}

/* ------------------------- PHASE 1: QUALIFY ------------------------- */
async function phase1({ text, replies, newState }) {
  // First message?
  if (!newState._welcomed) {
    newState._welcomed = true;
    replies.push({
      type: "text",
      text:
        "Hi! 👋 Ako ang AI consultant ng BentaCars. Tutulungan kitang maghanap ng swak na unit — mabilis at klaro lang tayo. 🚗",
    });
  }

  // Run LLM extractor on every user turn; merge into stored qualifiers
  const prev = newState.qualifier || {};
  const merged = await extractQualifiers(text, prev);
  newState.qualifier = merged;

  // Ask next missing (LLM conversational)
  const missing = missingFields(merged);
  if (missing.length > 0) {
    const ask = await askForMissingConversational(missing, text);
    replies.push({ type: "text", text: ask });
    return { replies, newState };
  }

  // Complete -> summarize and move to Phase 2
  const sum = formatSummary(merged);
  replies.push({
    type: "text",
    text: `Nice, kompleto na ✅ I’ll match units based on: ${sum}. Saglit, i-check ko inventory…`,
  });

  newState.phase = "phase2";
  return { replies, newState };
}

/* ------------------------- PHASE 2: MATCH/OFFERS -------------------- */
async function phase2({ replies, newState, text }) {
  const { qualifier } = newState;

  // “Others / more” paging
  if (/others|iba pa|more/i.test(text)) {
    const backup = newState._backupUnits || [];
    if (!backup.length) {
      replies.push({ type: "text", text: "Wala nang exact match. Gusto mo mag-try ng alternatives (ibang brand/body type/budget)?" });
      return { replies, newState };
    }
    for (const u of backup) replies.push(await formatUnitReply(u, qualifier.payment));
    replies.push({ type: "text", text: "Alin dito gusto mong i-view? 😊" });
    return { replies, newState };
  }

  // Fetch matches
  const { mainUnits, backupUnits } = await matchUnits(qualifier);

  if (!mainUnits.length && !backupUnits.length) {
    replies.push({
      type: "text",
      text: "Medyo wala tayong exact match sa hanap mo. Pwede nating i-adjust (budget/brand/body type) — okay ba?",
    });
    return { replies, newState };
  }

  for (const u of mainUnits) replies.push(await formatUnitReply(u, qualifier.payment));

  newState._offeredUnits = mainUnits;
  newState._backupUnits = backupUnits;

  const buttons = [
    ...mainUnits.map((u, i) => ({ type: "postback", title: `Unit ${i + 1}`, payload: `UNIT_PICK_${u.SKU}` })),
    { type: "postback", title: "Others", payload: "SHOW_OTHERS" },
  ];

  replies.push({ type: "buttons", text: "Gusto mo i-view yung alin dito?", buttons });

  return { replies, newState };
}

export { router as route };
