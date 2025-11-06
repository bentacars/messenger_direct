// server/flows/router.js
// Main orchestrator for Phase 1 → Phase 2 → Phase 3
// LLM-powered, state-aware, human conversational logic

import { askLLM } from "../lib/ai.js";
import { extractQualifiers, missingFields, askForMissingConversational } from "./qualifier.js";
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

  // ---- 0. Initialize phase if new ----
  if (!newState.phase) {
    newState.phase = "phase1";
    newState.created_at = Date.now();
  }

  // ---- 0.a Compute whether interrupts are allowed ----
  const isPhase1 = newState.phase === "phase1";
  const qualForCheck = newState.qualifier || {};
  const needNow = isPhase1 ? missingFields(qualForCheck) : [];
  const canInterrupt = !isPhase1 || needNow.length === 0;

  // ---- 0.b Interrupts: FAQ / Objection / Small-talk layer (only when allowed) ----
  if (canInterrupt) {
    const interrupt = await handleInterrupts(text, newState);
    if (interrupt) {
      replies.push({ type: "text", text: interrupt.reply });
      if (interrupt.resume) replies.push({ type: "text", text: interrupt.resume });
      return { replies, newState };
    }
  }

  // ---- 1. Phase Routing ----
  switch (newState.phase) {
    case "phase1":
      return await handlePhase1({ ctx, replies, newState, text });

    case "phase2":
      return await handlePhase2({ ctx, replies, newState, text });

    case "cash":
      return await handleCashFlow({ ctx, replies, newState, text, attachments });

    case "financing":
      return await handleFinancingFlow({ ctx, replies, newState, text, attachments });

    default:
      replies.push({ type: "text", text: "Oops, mukhang naputol flow natin. Start ulit tayo?" });
      return { replies, newState: { phase: "phase1", qualifier: {}, created_at: Date.now() } };
  }
}

/* ------------------------------------------------------------
 * PHASE 1: QUALIFYING
 * ------------------------------------------------------------ */
async function handlePhase1({ ctx, replies, newState, text }) {
  const firstTime = !newState._welcomed;
  const within7d = !!newState.created_at && (Date.now() - newState.created_at) < 7 * 864e5;

  // First touch: greet once; returning users get Continue/Start over
  if (firstTime) {
    newState._welcomed = true;

    if (within7d && newState.qualifier && Object.keys(newState.qualifier).length > 0) {
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
      text: "Hi! 👋 Ako yung AI consultant ng BentaCars. Taglish lang tayo para mabilis ah. Hanapan kita ng best unit — iwas scroll-scroll. 🚗",
    });
  }

  // Handle explicit "start over" / button payloads
  if (/start over/i.test(text) || /START_OVER/.test(text)) {
    replies.push({ type: "text", text: "Sige, from the top tayo! 🔄 Quick one lang — cash or financing ang plan mo?" });
    return { replies, newState: { phase: "phase1", qualifier: {}, created_at: Date.now(), _welcomed: true } };
  }
  if (/continue/i.test(text) || /CONTINUE_PHASE/.test(text)) {
    // Just continue where we left off; fall-through
  }

  // Extract any qualifiers from this message (free order)
  const qual = extractQualifiers(text, newState.qualifier || {});
  newState.qualifier = qual;

  // Detect missing qualifier fields (Phase 1 lock)
  const missing = missingFields(qual);
  if (missing.length > 0) {
    // Avoid re-asking the same field within 120s
    const now = Date.now();
    const nextField = missing[0];
    const last = newState._lastAsk || {};
    if (!(last.field === nextField && now - (last.ts || 0) < 120000)) {
      const nextAsk = await askForMissingConversational(missing, text);
      replies.push({ type: "text", text: nextAsk });
      newState._lastAsk = { field: nextField, ts: now };
    }
    // If we recently asked the same thing, stay quiet (prevents spam)
    return { replies, newState };
  }

  // All fields complete → summarize + move to Phase 2
  newState._lastAsk = null;
  const sum = formatSummary(qual);
  replies.push({
    type: "text",
    text: `Nice, kompleto na ✅ I’ll match units based on: ${sum}. Saglit lang, i-check ko inventory...`,
  });

  newState.phase = "phase2";
  return { replies, newState };
}

/* ------------------------------------------------------------
 * PHASE 2: MATCHING / OFFERS
 * ------------------------------------------------------------ */
async function handlePhase2({ ctx, replies, newState, text }) {
  const { qualifier = {} } = newState;

  // Handle "Others" / "More"
  if (/^(others|iba pa|more)$/i.test(text) || /SHOW_OTHERS/.test(text)) {
    const backup = newState._backupUnits || [];
    if (!backup.length) {
      replies.push({ type: "text", text: "Wala nang exact match, pero pwede kitang i-check ng alternatives (brand/body type/budget adjust). G?" });
      return { replies, newState };
    }
    for (const unit of backup) {
      replies.push(await formatUnitReply(unit, qualifier.payment));
    }
    replies.push({ type: "text", text: "Alin dito gusto mong i-view? 😊" });
    return { replies, newState };
  }

  // Handle unit pick via payload-like text (e.g., "UNIT_PICK_<SKU>") or natural mention
  const pickMatch = text.match(/UNIT_PICK_([A-Za-z0-9\-\._]+)/) || text.match(/\bSKU[:#\s]*([A-Za-z0-9\-\._]+)\b/i);
  if (pickMatch) {
    const sku = pickMatch[1];
    newState.selectedSKU = sku;
    const path = qualifier.payment === "cash" ? "cash" : "financing";
    replies.push({ type: "text", text: "Solid choice! 🔥 Sending full photos…" });
    newState.phase = path;
    return { replies, newState };
  }

  // First-time Phase 2 entry → fetch matches
  if (!newState._offeredOnce) {
    const { mainUnits, backupUnits } = await matchUnits(qualifier);

    if (mainUnits.length === 0 && backupUnits.length === 0) {
      replies.push({
        type: "text",
        text: "Medyo wala akong exact match based sa detalye mo 😕 Gusto mo bang i-widen natin? Pwede dagdag budget, adjust body type, or ibang brand.",
      });
      return { replies, newState };
    }

    // Show first 2 units
    for (const u of mainUnits) {
      replies.push(await formatUnitReply(u, qualifier.payment));
    }

    newState._offeredOnce = true;
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

  // If already offered once and no clear command, gently nudge
  replies.push({ type: "text", text: "Type mo lang ‘Unit 1’ or ‘Unit 2’ para ma-lock natin viewing. Pwede rin ‘Others’ kung gusto mo ng alternatives." });
  return { replies, newState };
}

export { router as route };
