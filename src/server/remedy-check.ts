// ── Watchdog remedy checks ──
// The stall watchdog is the safety net for unreachable stuck states; these
// checks pin its RESCUE CASCADE so it always targets the right action.
// Run: npm run remedy

import { createGame, type PlayerMeta } from '../shared/engine.js'
import { remedyActionsFor } from './rooms.js'
import type { GameState } from '../shared/types.js'

const METAS: PlayerMeta[] = [
  { id: 'p0', name: 'Asha', color: '#000', token: 'a' },
  { id: 'p1', name: 'Ben', color: '#000', token: 'b' },
]

let checks = 0
const failures: string[] = []
function eq(actual: unknown, expected: unknown, msg: string): void {
  checks++
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${msg} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
  }
}

function fresh(): GameState {
  return createGame(METAS)
}

// ROLL stuck → force the roll
{
  const s = fresh()
  eq(remedyActionsFor(s), [['p0', { type: 'roll' }]], 'ROLL remedy is a forced roll for the current player')
}

// pending card reveal stuck → draw it
{
  const s = fresh()
  s.phase = 'ACTION'
  s.pendingCardDraw = { player: 'p0', deck: 'chest', space: 17 }
  eq(remedyActionsFor(s), [['p0', { type: 'drawCard' }]], 'pending reveal is rescued with drawCard')
}

// pending purchase stuck → send it to auction
{
  const s = fresh()
  s.phase = 'ACTION'
  s.pendingPurchase = 6
  eq(remedyActionsFor(s), [['p0', { type: 'declineBuy' }]], 'pending purchase is rescued with declineBuy')
}

// pending tax stuck → pay it flat
{
  const s = fresh()
  s.phase = 'ACTION'
  s.pendingTax = { player: 'p0', space: 4 }
  eq(remedyActionsFor(s), [['p0', { type: 'payTax', choice: 'flat' }]], 'pending tax is rescued with payTax')
}

// plain ACTION stuck → end the turn
{
  const s = fresh()
  s.phase = 'ACTION'
  eq(remedyActionsFor(s), [['p0', { type: 'endTurn' }]], 'plain ACTION is rescued with endTurn')
}

// debt stuck, debtor can pay → pay
{
  const s = fresh()
  s.phase = 'DEBT'
  s.debt = { debtor: 'p0', amount: 50, creditor: null }
  eq(remedyActionsFor(s), [['p0', { type: 'payDebt' }]], 'solvent debtor is rescued with payDebt')
}

// debt stuck, debtor broke → bankrupt
{
  const s = fresh()
  s.phase = 'DEBT'
  s.players[0].cash = 10
  s.debt = { debtor: 'p0', amount: 50, creditor: null }
  eq(remedyActionsFor(s), [['p0', { type: 'bankrupt' }]], 'insolvent debtor is rescued with bankrupt')
}

// nothing to do for finished games
{
  const s = fresh()
  s.phase = 'GAME_OVER'
  eq(remedyActionsFor(s), [], 'no remedy for GAME_OVER')
}

if (failures.length > 0) {
  console.log(`✗ ${failures.length} of ${checks + failures.length} remedy checks failed:`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log(`✔ all remedy checks passed (${checks} checks)`)
