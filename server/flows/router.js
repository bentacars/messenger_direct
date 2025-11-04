// api/flows/router.js
// Central conversation router for Phase 1 → Phase 2 → Phase 3

import * as Qualifier from './qualifier.js';
import * as Offers from './offers.js';
import * as CashFlow from './cash.js';
import * as FinancingFlow from './financing.js';

const MEMORY_TTL_DAYS = Number(process.env.MEMORY_TTL_DAYS || 7);

// ---- helpers ----
function isStale(ts) {
  const ttl = MEMORY_TTL_DAYS * 24 * 60 * 60 * 1000;
  return !ts || Date.now() - ts > ttl;
}

function welcomeBlock(session) {
  const firstTime = !session.createdAt || isStale(session.createdAtTs);
  if (firstTime) {
    return [{
      type: 'text',
      text: "Hi! 👋 I’m your BentaCars consultant. Ako na bahala mag-match ng best unit para sa’yo—hindi mo na kailangang mag-scroll nang mag-scroll. Let’s find your car, fast.",
    }];
  }
  return [{
    type: 'buttons',
    text: "Welcome back! 👋 Gusto mo bang ituloy kung saan tayo huli, or start over?",
    buttons: [
      { title: 'Continue', payload: 'CONTINUE' },
      { title: 'Start over', payload: 'start over' },
    ],
  }];
}

function needPhase1(qual) {
  return !(qual?.payment && qual?.budget && qual?.location && qual?.transmission && qual?.bodyType);
}

function shortAskForMissing(qual) {
  const prompts = [];
  if (!qual.payment) prompts.push("Cash or financing ang plan mo?");
  if (!qual.location) prompts.push("Saan location mo? (city/province)");
  if (!qual.bodyType) prompts.push("Anong body type hanap mo? (sedan/suv/mpv/van/pickup — or type 'any')");
  if (!qual.transmission) prompts.push("Auto or manual? (pwede rin 'any')");
  if (!qual.budget) prompts.push("Budget range mo? (cash SRP or cash-out kung financing)");
  return prompts.length ? prompts[0] : null;
}

// ---- main route ----
export async function route(session, userText, rawEvent) {
  const messages = [];
  const now = Date.now();

  // bootstrap session
  session.createdAtTs = session.createdAtTs || now;
  session.phase = session.phase || 'phase1';
  session.qualifier = session.qualifier || {};
  session.funnel = session.funnel || {};

  // Phase 1: welcome + collect qualifiers in any order
  if (session.phase === 'phase1') {
    if (!session._welcomed) {
      messages.push(...welcomeBlock(session));
      session._welcomed = true;
      // If we just welcomed, we still try parse current text in case user replied with data
    }

    // Parse any qualifiers from this turn (free order, Taglish)
    if (userText) {
      session.qualifier = Qualifier.absorb(session.qualifier, userText);
    }

    // Ask only the missing field, conversational and short
    if (needPhase1(session.qualifier)) {
      const ask = shortAskForMissing(session.qualifier);
      if (ask) messages.push({ type: 'text', text: ask });
      session.phase = 'phase1';
      return { session, messages };
    }

    // Summarize + move to offers
    const sum = Qualifier.summary(session.qualifier);
    messages.push({
      type: 'text',
      text: `Got it. ✅ Here’s what I’ll match: ${sum}. Iche-check ko ang inventory, then ibabalik ko 2 options na swak.`,
    });

    session.phase = 'phase2';
  }

  // Phase 2: show offers (2 first, with “Others” path)
  if (session.phase === 'phase2') {
    const step = await Offers.step(session, userText, rawEvent);
    messages.push(...step.messages);
    session = step.session;

    // If user picked a unit and photos have been sent, Offers sets session.nextPhase
    if (session.nextPhase === 'cash') {
      session.phase = 'cash';
    } else if (session.nextPhase === 'financing') {
      session.phase = 'financing';
    } else {
      // still in offers carousel loop
      return { session, messages };
    }
  }

  // Phase 3A: Cash path (schedule → contact → address)
  if (session.phase === 'cash') {
    const step = await CashFlow.step(session, userText, rawEvent);
    messages.push(...step.messages);
    session = step.session;
    return { session, messages };
  }

  // Phase 3B: Financing path (schedule → contact → address → income/doc flow)
  if (session.phase === 'financing') {
    const step = await FinancingFlow.step(session, userText, rawEvent);
    messages.push(...step.messages);
    session = step.session;
    return { session, messages };
  }

  // Fallback (shouldn’t hit often)
  messages.push({ type: 'text', text: 'Sige, tuloy lang tayo. Cash or financing ang plan mo para ma-match ko properly?' });
  session.phase = 'phase1';
  return { session, messages };
}
