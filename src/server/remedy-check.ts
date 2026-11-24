// ── Watchdog remedy checks ──
// The stall watchdog is the safety net for unreachable stuck states; these
// checks pin its RESCUE CASCADE so it always targets the right action.
// Run: npm run remedy

import { createGame, type PlayerMeta } from '../shared/engine.js'
import { decisionFor, remedyActionsFor } from './rooms.js'
import type { DebtState, GameState } from '../shared/types.js'

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

// ── decisionFor: the two-tier debt clock ──

// an AFFORDABLE debt arms a fixed 30s tap clock even with the host timer off
{
  const s = fresh()
  s.phase = 'DEBT'
  s.debt = { debtor: 'p0', amount: 50, creditor: null, memo: 'Luxury tax' }
  eq(decisionFor(s, 0), { key: 'debt:1:p0:bank:50:0', playerId: 'p0', ms: 30_000 }, 'affordable debt arms 30s even at timeout 0')
}

// an UNAFFORDABLE debt: unarmed while the timer is off, host clock when on
{
  const s = fresh()
  s.phase = 'DEBT'
  s.players[0].cash = 10
  s.debt = { debtor: 'p0', amount: 500, creditor: 'p1', memo: 'Rent: Boardwalk' }
  eq(decisionFor(s, 0), null, 'unaffordable debt stays unarmed while the timer is off')
  eq(decisionFor(s, 120_000)?.ms, 120_000, 'unaffordable debt runs on the host clock')
}

// relay rows from ONE debtor must never collide into a single clock key —
// the old `debt:turn:debtor` key reused itself, and later rows inherited an
// already-expired timer (scheduleDeadline returned early).
{
  const s = fresh()
  s.phase = 'DEBT'
  const memo = 'Card: Elected Chairman of the Board. Pay each player $50.'
  const rows: DebtState[] = [
    { debtor: 'p0', amount: 50, creditor: 'p1', memo },
    { debtor: 'p0', amount: 50, creditor: 'p2', memo },
    { debtor: 'p0', amount: 50, creditor: null, memo }, // bank re-point — same shape again
  ]
  const keys: string[] = []
  for (let n = 0; n < rows.length; n++) {
    s.debt = rows[n]
    s.debtQueue = rows.slice(n + 1)
    const d = decisionFor(s, 0)
    if (d) keys.push(d.key)
  }
  eq(keys.length, 3, 'every relay row was clocked')
  eq(new Set(keys).size, 3, 'relay rows never collide — one fresh clock per debt')
}

// a plain roll decision respects the host switch entirely
{
  const s = fresh()
  eq(decisionFor(s, 0), null, 'no clock for a roll when the timer is off')
  eq(decisionFor(s, 90_000)?.ms, 90_000, 'the roll clock follows the host timer')
}

// arrests keep their fixed clock
{
  const s = fresh()
  s.phase = 'ACTION'
  s.pendingJail = { player: 'p0', reason: 'card' }
  eq(decisionFor(s, 0)?.ms, 30_000, 'the arrest clock survives the timer switch')
}

if (failures.length > 0) {
  console.log(`✗ ${failures.length} of ${checks + failures.length} remedy checks failed:`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log(`✔ all remedy checks passed (${checks} checks)`)
