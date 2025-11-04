import { P } from '../lib/prompts.js';
import { shouldDebounce } from '../lib/state.js';

function nextMissing(slots) {
  if (!slots.plan) return 'plan';
  if (!slots.budget && slots.plan === 'cash') return 'budgetCash';
  if (!slots.location) return 'location';
  if (!slots.body_type) return 'body';
  if (!slots.transmission) return 'trans';
  // for financing, we don't need cash budget here (Phase 3 will handle)
  return null;
}

export function absorbParsed(slots, parsed) {
  // merge parser findings
  if (parsed.plan) slots.plan = parsed.plan;
  if (parsed.budget && slots.plan === 'cash') slots.budget = parsed.budget;
  if (parsed.location) slots.location = parsed.location;
  if (parsed.transmission) slots.transmission = parsed.transmission;
  if (parsed.body_type) slots.body_type = parsed.body_type;
  if (parsed.brand_pref) slots.brand_pref = parsed.brand_pref;
  if (parsed.model_pref) slots.model_pref = parsed.model_pref;
  if (parsed.year_pref) slots.year_pref = parsed.year_pref;
  if (parsed.variant_pref) slots.variant_pref = parsed.variant_pref;
}

export function qualifierTurn(session, parsed) {
  const actions = [];
  const { slots } = session;

  // Merge any info we just parsed
  absorbParsed(slots, parsed);

  // Decide what to ask next (non-sequential but fixed priority)
  const missing = nextMissing(slots);

  if (!session.isWelcomed) {
    // First contact
    actions.push({ type:'text', text: session.isReturning ? P.greetReturning() : P.greetNew() });
    session.isWelcomed = true;
    if (!missing) {
      // nothing to ask—rare; move forward
      return { actions, done:true };
    }
  }

  if (missing) {
    // Debounce same-slot repeats
    if (!shouldDebounce(session.psid, missing)) {
      switch (missing) {
        case 'plan': actions.push({ type:'text', text: P.askPlan() }); break;
        case 'budgetCash': actions.push({ type:'text', text: P.askBudgetCash() }); break;
        case 'location': actions.push({ type:'text', text: P.askLocation() }); break;
        case 'body': actions.push({ type:'text', text: P.askBody() }); break;
        case 'trans': actions.push({ type:'text', text: P.askTrans() }); break;
      }
    }
    return { actions, done:false };
  }

  // All 5 collected (for financing, budget may be null by design)
  const lines = [];
  lines.push(P.summaryIntro());
  lines.push(`• Payment: ${slots.plan}`);
  if (slots.plan === 'cash' && slots.budget) lines.push(`• Budget: ₱${Intl.NumberFormat('en-PH').format(slots.budget)}`);
  lines.push(`• Location: ${slots.location}`);
  lines.push(`• Body type: ${slots.body_type}`);
  lines.push(`• Transmission: ${slots.transmission}`);
  actions.push({ type:'text', text: lines.join('\n') });

  // hand-off to Phase 2 (will be wired in Part 2)
  actions.push({ type:'text', text: "Saglit, iche-check ko ang live inventory para ma-offer ko agad yung best 2 units for you. 🔎" });

  session.phase = 'p2_pending';
  return { actions, done:true };
}
