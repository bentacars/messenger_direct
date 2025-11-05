// server/lib/interrupts.js
import { classifyInterrupt, aiAnswerFAQ } from './llm.js';

export async function handleInterrupts({ utterance, state }) {
  const label = await classifyInterrupt(utterance);
  if (label.includes('progress')) return { handled: false }; // let main flow use it

  if (label.includes('faq') || label.includes('objection') || label.includes('offtopic')) {
    const reply = await aiAnswerFAQ(utterance, { phase: state.phase, pending: state.pending });
    return { handled: true, text: reply };
  }

  return { handled: false };
}
