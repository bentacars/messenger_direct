import { qualifierTurn } from './qualifier.js';

export async function handleTurn(session, parsed) {
  // For Part 1 we only support Phase 1
  // Later we’ll call middleware (FAQ), offers, car-knowledge, cash/fin flows, etc.
  return qualifierTurn(session, parsed);
}
