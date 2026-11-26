// ── Watchdog remedy checks ──
// The stall watchdog is the safety net for unreachable stuck states; these
// checks pin its RESCUE CASCADE so it always targets the right action, and
// pin the decision clocks + auction-grace predicate that keep one idle
// phone from stalling the table. Run: npm run remedy

import { createGame, type PlayerMeta } from '../shared/engine.js'
import { auctionGraceActions, decisionFor, remedyActionsFor, type Room } from './rooms.js'
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

// an UNAFFORDABLE debt now arms the fixed 90s autoSettle clock at
// timer-off (was: unarmed) — expiry liquidates minimally and pays instead
// of bankrupting a recoverable seat. With the host clock on, it governs.
{
  const s = fresh()
  s.phase = 'DEBT'
  s.players[0].cash = 10
  s.debt = { debtor: 'p0', amount: 500, creditor: 'p1', memo: 'Rent: Boardwalk' }
  eq(decisionFor(s, 0)?.ms, 90_000, 'unaffordable debt arms the 90s raise-funds clock at timer-off')
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

// a plain roll decision: the host clock when on, the fixed 60s default
// when off (was: unarmed) — the expiry auto-rolls
{
  const s = fresh()
  eq(decisionFor(s, 0)?.ms, 60_000, 'a roll arms the fixed 60s default at timer-off')
  eq(decisionFor(s, 90_000)?.ms, 90_000, 'the roll clock follows the host timer')
}

// every other blocking decision arms its timer-off default too: one idle
// phone can never stall a timer-off table
{
  const s = fresh()
  s.phase = 'ACTION'
  s.pendingCardDraw = { player: 'p0', deck: 'chest', space: 17 }
  eq(decisionFor(s, 0)?.ms, 30_000, 'a pending draw arms 30s at timer-off')
  s.pendingCardDraw = null
  s.pendingPurchase = 6
  eq(decisionFor(s, 0)?.ms, 60_000, 'a pending buy arms 60s at timer-off')
  s.pendingPurchase = null
  s.pendingTax = { player: 'p0', space: 4 }
  eq(decisionFor(s, 0)?.ms, 60_000, 'a pending tax arms 60s at timer-off')
  s.pendingTax = null
}

// auctions keep their fixed windows at timer-off and their min() shape
// when the host clock is on
{
  const s = fresh()
  s.phase = 'AUCTION'
  s.auction = { space: 6, bid: 0, bidder: null, passed: [] }
  eq(decisionFor(s, 0)?.ms, 30_000, 'auction opening window is 30s at timer-off')
  eq(decisionFor(s, 20_000)?.ms, 20_000, 'a shorter host fuse wins over the opening window')
  s.auction = { space: 6, bid: 40, bidder: 'p1', passed: [] }
  eq(decisionFor(s, 0)?.ms, 15_000, 'the after-a-bid fuse is 15s at timer-off')
  eq(decisionFor(s, 20_000)?.ms, 15_000, 'the min() shape survives with the host clock on')
}

// ── auctionGraceActions: predicate parity with the old inline check ──
// The same seats the piggybacked broadcastGame check passed: alive, gone
// past the grace window, not yet passed on this auction, not the high
// bidder. Everyone else — connected, recently dropped, passed, the
// bidder, the bankrupt — is not due.
{
  // a 4-seat game (the grace predicate iterates every seat)
  const metas: PlayerMeta[] = [
    { id: 'p0', name: 'Asha', color: '#000', token: 'a' },
    { id: 'p1', name: 'Ben', color: '#000', token: 'b' },
    { id: 'p2', name: 'Cho', color: '#000', token: 'c' },
    { id: 'p3', name: 'Dara', color: '#000', token: 'd' },
  ]
  const s = createGame(metas)
  s.phase = 'AUCTION'
  s.auction = { space: 6, bid: 40, bidder: 'p1', passed: ['p2'] }
  s.players[3].bankrupt = true
  const seat = (id: string, socketId: string | null, goneFor: number) => ({
    meta: metas.find((m) => m.id === id) ?? metas[0],
    token: `t-${id}`,
    socketId,
    disconnectedAt: socketId == null ? Date.now() - goneFor : null,
  })
  const room: Room = {
    code: 'TEST',
    hostToken: 't',
    hostPlayerId: null,
    turnTimeoutMs: 0,
    state: s,
    hostSockets: new Set(),
    players: [
      seat('p0', null, 20_000), // gone 20s → due
      seat('p1', 'sock-1', 0), // connected + high bidder → not due
      seat('p2', null, 20_000), // gone, but already passed → not due
      seat('p3', null, 20_000), // gone, but bankrupt → not due
    ],
    lastActive: Date.now(),
    timer: null,
    timerKey: null,
    watchdogBusy: false,
    graceTimer: null,
    graceKey: null,
  }
  eq(auctionGraceActions(room), [['p0', { type: 'passBid' }]], 'grace passes exactly the seat the old inline check passed')

  // a seat inside the window is not due yet — the fuse, not the
  // piggyback, covers it
  room.players[0].disconnectedAt = Date.now() - 5_000
  eq(auctionGraceActions(room), [], 'a seat still inside the grace window is left alone')

  // no auction, no grace
  room.players[0].disconnectedAt = Date.now() - 20_000
  s.phase = 'ROLL'
  s.auction = null
  eq(auctionGraceActions(room), [], 'no auction live → no grace actions')
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
