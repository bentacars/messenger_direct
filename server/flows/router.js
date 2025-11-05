// server/flows/router.js
// Main orchestrator for Phase 1 → Phase 2 → Phase 3
// LLM-powered, state-aware, human conversational logic

import { askLLM } from "../lib/ai.js";
import { extractQualifiers, missingFields } from "./qualifier.js";
import { matchUnits, formatUnitReply } from "./offers.js";
import { handleCashFlow } from "./cash.js";
import { handleFinancingFlow } from "./financing.js";
import { handleInterrupts } from "../lib/interrupts.js";
import { formatSummary } from "../lib/model.js";

export async function router(ctx) {
  const {
    psid,
    text = "",
    attachments = [],
    state = {},
  } = ctx;

  const replies = [];
  let newState = { ...state }; // mutable session state
  let reset = false;

  // ---- 0. Interrupts: FAQ / Objection / Small-talk layer ----
  const interrupt = await handleInterrupts(text, newState);
  if (interrupt) {
    replies.push({ type: "text", text: interrupt.reply });
    if (interrupt.resume) replies.push({ type: "text", text: interrupt.resume });
    return { replies, newState };
  }

  // ---- 1. Initialize phase if new ----
  if (!newState.phase) {
    newState.phase = "phase1";
    newState.created_at = Date.now();
  }

  // ---- 2. Phase Routing ----
  switch (newState.phase) {
    case "phase1":
      return await handlePhase1({ ctx, replies, newState, text });

    case "phase2":
      return await handlePhase2({ ctx, replies, newState, text });

    case "cash":
      return await handleCashFlow({ ctx, replies, newState, text });

    case "financing":
      return await handleFinancingFlow({ ctx, replies, newState, text });

    default:
      replies.push({ type: "text", text: "Oops, mukhang naputol flow natin. Start ulit tayo?" });
      reset = true;
      break;
  }

  return { replies, reset };
}

/* ------------------------------------------------------------
 * PHASE 1: QUALIFYING
 * ------------------------------------------------------------ */
async function handlePhase1({ ctx, replies, newState, text }) {
  const firstTime = !newState._welcomed;
  const isReturning = !!newState.created_at && Date.now() - newState.created_at < 7 * 864e5;

  if (firstTime) {
    newState._welcomed = true;
    if (isReturning && newState.qualifier) {
      replies.push({
        type: "buttons",
        text: "Welcome back! 👋 Gusto mo bang ituloy kung saan tayo huli, or start over?",
        buttons: [
          { type: "postback", title: "Continue", payload: "CONTINUE_PHASE" },
          { type: "postback", title: "Start over", payload: "START_OVER" },
        ],
      });
      return { replies, newState };
    }

    replies.push({
      type: "text",
      text: "Hi! 👋 Ako yung AI consultant ng BentaCars. Taglish lang tayo para mabilis ah. Sige, hanapan kita ng best unit — iwas scroll-scroll. 🚗",
    });
  }

  if (/start over/i.test(text)) {
    replies.push({ type: "text", text: "Alright, from the top tayo! 🔄 Sige, quick question — cash or financing ang balak mo?" });
    return { replies, newState: { phase: "phase1", qualifier: {} } };
  }

  // Extract qualifiers from message (AI or regex)
  const qual = extractQualifiers(text, newState.qualifier || {});
  newState.qualifier = qual;

  // Detect missing qualifier fields
  const missing = missingFields(qual);
  if (missing.length > 0) {
    const nextAsk = await askLLM(
      `
      You're a friendly Taglish car sales AI. Ask the user the next missing qualifier.
      Missing fields: ${missing.join(", ")}.
      Their previous reply: "${text}".
      Keep it SHORT, friendly, human.
      `
    );
    replies.push({ type: "text", text: nextAsk });
    return { replies, newState };
  }

  // All fields are complete — summarize and move to phase2
  const sum = formatSummary(qual);
  replies.push({
    type: "text",
    text: `Nice, kompleto na ✅ I’ll match units based on: ${sum}. Saglit lang, icheck ko inventory...`,
  });

  newState.phase = "phase2";
  return { replies, newState };
}

/* ------------------------------------------------------------
 * PHASE 2: MATCHING / OFFERS
 * ------------------------------------------------------------ */
async function handlePhase2({ ctx, replies, newState, text }) {
  const { qualifier } = newState;

  // SPECIAL CASE: User asked for "Others" or scroll more units
  if (/others|iba pa|more/i.test(text)) {
    const backup = newState._backupUnits || [];
    if (backup.length === 0) {
      replies.push({ type: "text", text: "Unfortunately, wala na tayong masyadong kapareho ng hanap mo. Pwede kitang i-check ng alternatives?" });
      return { replies, newState };
    }

    for (const unit of backup) {
      replies.push(await formatUnitReply(unit, qualifier.payment));
    }
    replies.push({ type: "text", text: "Alin kaya dito gusto mong i-view? 😊" });
    return { replies, newState };
  }

  // BEGIN FETCH MATCHES
  const { mainUnits, backupUnits } = await matchUnits(qualifier);

  if (mainUnits.length === 0 && backupUnits.length === 0) {
    replies.push({
      type: "text",
      text: "Medyo wala akong exact match based sa detalye mo 😕 Gusto mo bang mag-widen tayo? Pwede dagdag budget, body type, or brand.",
    });
    return { replies, newState };
  }

  // Show first 2 units first
  for (const u of mainUnits) {
    replies.push(await formatUnitReply(u, qualifier.payment));
  }

  newState._offeredUnits = mainUnits;
  newState._backupUnits = backupUnits;

  const btns = mainUnits.map((u, i) => ({
    type: "postback",
    title: `Unit ${i + 1}`,
    payload: `UNIT_PICK_${u.SKU}`,
  }));
  btns.push({ type: "postback", title: "Others", payload: "SHOW_OTHERS" });

  replies.push({
    type: "buttons",
    text: "Gusto mo i-view yung alin dito?",
    buttons: btns,
  });

  return { replies, newState };
}
