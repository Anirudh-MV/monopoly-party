// ── Scenario simulations ──
// Deterministic, white-box tests for every expected rules situation, one file
// next to the random fuzzer (sim.ts). Each scenario shapes a fresh GameState,
// plays rigged dice through the real reducer, and asserts exact outcomes.
// Run: npm run scenarios

import {
  applyAction,
  createGame,
  forfeitEstate,
  liquidationPlan,
  MAX_GAME_LOG,
  type PlayerMeta,
  type Result,
} from '../shared/engine.js'
import { auctionGraceActions, commit, debtAutoActions, decisionFor, forfeitSeat, type Room } from './rooms.js'
import { allowedActions, blockingDecision, debtBlurb, rentFor, rentPreview } from '../shared/rules.js'
import { hostView } from '../shared/views.js'
import { ALL_CARDS, cardById } from '../shared/cards.js'
import { cardEffectLine, debtWhy } from '../shared/card-effect.js'
import type { Action, DebtState, GameState, PlayerState, PropertyState } from '../shared/types.js'

const NAMES = ['Asha', 'Ben', 'Cho', 'Dara']
const TOKENS = ['🎩', '🚗', '🐕', '🚢']

// Deterministic rng for replay scenarios (the same generator the
// simulator uses) — the backbone of the rng-threading checks.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// A stub room around an engine state: io null means commit() runs its core
// (clone, apply, commit) with no broadcast, no timers, no disk writes.
function stubRoom(s: GameState): Room {
  return {
    code: 'TEST',
    hostToken: 't',
    hostPlayerId: null,
    turnTimeoutMs: 0,
    state: structuredClone(s),
    hostSockets: new Set(),
    players: [],
    lastActive: Date.now(),
    timer: null,
    timerKey: null,
    watchdogBusy: false,
    graceTimer: null,
    graceKey: null,
  }
}

// A rigged rng: each pair is one die roll, consumed in order.
function rig(...pairs: number[][]): () => number {
  const flat: number[] = []
  for (const p of pairs) flat.push(...p)
  let i = 0
  return () => {
    const die = flat[i]
    if (die == null) return Math.random()
    i++
    return (die - 1 + 0.5) / 6
  }
}

interface Helpers {
  s: GameState
  id: (i: number) => string
  p: (i: number) => PlayerState
  cash: (i: number, n: number) => void
  prop: (space: number, over: Partial<PropertyState>) => void
  give: (i: number, spaces: number[]) => void
  now: (i: number, phase?: GameState['phase']) => void
  act: (i: number, a: Action, pairs?: number[][]) => Result
  roll: (i: number, pairs: number[][]) => Result
  ok: (r: Result, msg: string) => void
  bad: (r: Result, msg: string) => void
  assert: (c: boolean, msg: string) => void
  eq: (a: unknown, b: unknown, msg: string) => void
}

let totalChecks = 0
let failures: string[] = []

function scenario(name: string, playerCount: number, fn: (h: Helpers) => void): void {
  const metas: PlayerMeta[] = Array.from({ length: playerCount }, (_, i) => ({
    id: `p${i}`,
    name: NAMES[i],
    color: `#000000`,
    token: TOKENS[i],
  }))
  const s = createGame(metas)
  let checks = 0
  const h: Helpers = {
    s,
    id: (i) => `p${i}`,
    p: (i) => s.players[i],
    cash: (i, n) => {
      s.players[i].cash = n
    },
    prop: (space, over) => {
      const st = s.props[space]
      if (st) Object.assign(st, over)
    },
    give: (i, spaces) => {
      for (const sp of spaces) s.props[sp].owner = `p${i}`
    },
    now: (i, phase = 'ROLL') => {
      s.currentPlayerId = `p${i}`
      s.phase = phase
    },
    act: (i, a, pairs) => applyAction(s, a, `p${i}`, pairs ? rig(...pairs) : Math.random),
    roll: (i, pairs) => applyAction(s, { type: 'roll' }, `p${i}`, rig(...pairs)),
    ok: (r, msg) => {
      checks++
      if (!r.ok) failures.push(`${name}: expected ok — ${msg}: ${r.ok ? '' : r.error}`)
    },
    bad: (r, msg) => {
      checks++
      if (r.ok) failures.push(`${name}: expected rejection — ${msg}`)
    },
    assert: (c, msg) => {
      checks++
      if (!c) failures.push(`${name}: ${msg}`)
    },
    eq: (a, b, msg) => {
      checks++
      const same = a === b || JSON.stringify(a) === JSON.stringify(b)
      if (!same) failures.push(`${name}: ${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`)
    },
  }
  try {
    fn(h)
    totalChecks += checks
    console.log(`  ✓ ${name} (${checks} checks)`)
  } catch (e) {
    failures.push(`${name}: threw — ${e instanceof Error ? e.message : String(e)}`)
    console.log(`  ✗ ${name} threw`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────

scenario('passing GO pays $200, landing on GO too', 4, (h) => {
  h.cash(0, 1500)
  h.p(0).pos = 38
  h.roll(0, [[1, 1]]) // sum 2 → lands exactly on GO
  h.eq(h.p(0).pos, 0, 'landed on GO')
  h.eq(h.p(0).cash, 1700, 'collected $200')
  h.eq(h.s.phase, 'ROLL', 'doubles grants another roll')
})

scenario('rent: base, then color-set doubling on a doubles chain', 4, (h) => {
  h.give(0, [1])
  h.now(1)
  h.p(1).pos = 39
  h.roll(1, [[1, 1]]) // → Mediterranean (wrap past GO)
  h.eq(h.s.phase, 'DEBT', 'rent arrives as a pending debt, not a silent deduction')
  h.ok(h.act(1, { type: 'payDebt' }), 'the landing player pays it by hand')
  h.eq(h.p(1).cash, 1698, 'paid $2 base rent after +200 GO money')
  h.eq(h.p(0).cash, 1502, 'owner collected')
  // doubles → same player rolls again from pos 1
  h.give(0, [3]) // now owns the full brown group
  h.roll(1, [[1, 1]]) // → Baltic: doubled rent $8
  h.ok(h.act(1, { type: 'payDebt' }), 'pays the doubled rent too')
  h.eq(h.p(1).cash, 1690, 'color-set doubles the base rent')
  h.eq(h.p(0).cash, 1510, 'owner collected $8')
})

scenario('rent tables: houses, hotels, rails, utilities', 4, (h) => {
  h.give(0, [1, 3])
  h.eq(rentFor(h.s, 1, 7), 4, 'full brown set, no houses, doubled $4')
  h.eq(rentPreview(h.s, 1).current, 4, 'preview: doubled base with the full set')
  h.eq(rentPreview(h.s, 1).next, 10, 'preview: next tier is the 1-house rent')
  h.prop(1, { houses: 1 })
  h.eq(rentFor(h.s, 1, 7), 10, '1 house')
  h.prop(1, { houses: 2 })
  h.eq(rentFor(h.s, 1, 7), 30, '2 houses')
  h.prop(1, { houses: 3 })
  h.eq(rentFor(h.s, 1, 7), 90, '3 houses')
  h.prop(1, { houses: 4 })
  h.eq(rentFor(h.s, 1, 7), 160, '4 houses')
  h.prop(1, { houses: 5 })
  h.eq(rentFor(h.s, 1, 7), 250, 'hotel')
  h.give(0, [5, 15, 25])
  h.eq(rentFor(h.s, 5, 7), 100, 'three railroads → $100')
  h.give(0, [35])
  h.eq(rentFor(h.s, 5, 7), 200, 'four railroads → $200')
  h.give(0, [12])
  h.eq(rentFor(h.s, 12, 7), 28, 'one utility, roll 7 → 4×dice')
  h.give(0, [28])
  h.eq(rentFor(h.s, 12, 7), 70, 'both utilities → 10×dice')
  h.eq(rentPreview(h.s, 1).current, 250, 'preview: hotel rent')
  h.eq(rentPreview(h.s, 1).next, null, 'preview: nothing above a hotel')
  h.eq(rentPreview(h.s, 8).current, 6, 'preview: unowned street shows its base rent')
  h.eq(rentPreview(h.s, 5).current, 200, 'rail preview: current with all four rails')
  h.eq(rentPreview(h.s, 5).next, null, 'rail preview: nothing above four rails')
  h.eq(rentPreview(h.s, 5).note, '4 railroads', 'rail preview notes the count')
  h.eq(rentPreview(h.s, 12).current, 10, 'utility preview: 10× with both')
  h.eq(rentPreview(h.s, 12).next, null, 'utility preview: nothing above both')
})

scenario('mortgaged property charges no rent but still counts for the set', 4, (h) => {
  h.give(1, [5, 15, 25])
  h.prop(15, { mortgaged: true })
  h.eq(rentFor(h.s, 5, 7), 100, 'mortgaged rail still counts toward the count')
  h.now(0)
  h.p(0).pos = 13
  h.roll(0, [[1, 1]]) // → 15, mortgaged
  h.eq(h.p(0).cash, 1500, 'no rent charged on a mortgaged space')
})

scenario('income tax: flat $200 or 10% of total worth', 4, (h) => {
  h.now(0)
  h.p(0).pos = 2
  h.roll(0, [[1, 1]]) // → 4 Income Tax
  h.eq(h.s.pendingTax != null, true, 'tax decision pending')
  h.ok(h.act(0, { type: 'payTax', choice: 'flat' }), 'pay flat')
  h.eq(h.p(0).cash, 1300, 'flat $200 paid')

  h.now(0)
  h.s.pendingPurchase = null
  h.p(0).pos = 2
  h.give(0, [1]) // worth 1300 + 60 = 1360 → 10% = 136
  h.roll(0, [[1, 1]])
  h.ok(h.act(0, { type: 'payTax', choice: 'percent' }), 'pay 10%')
  h.eq(h.p(0).cash, 1164, '10% of worth (property counted at printed price)')
})

scenario('auction: bids, invalid bids, passes, winner', 4, (h) => {
  h.now(0)
  h.p(0).pos = 3
  h.roll(0, [[1, 1]]) // → 5 JR East - Yamanote Line, unowned
  h.ok(h.act(0, { type: 'declineBuy' }), 'decline → auction')
  h.eq(h.s.phase, 'AUCTION', 'auction phase')
  h.ok(h.act(1, { type: 'bid', amount: 50 }), 'Ben bids $50')
  h.bad(h.act(2, { type: 'bid', amount: 30 }), 'bid below current is rejected')
  h.ok(h.act(3, { type: 'bid', amount: 60 }), 'Dara bids $60')
  h.ok(h.act(0, { type: 'bid', amount: 70 }), 'Asha (the decliner) may still bid')
  h.ok(h.act(1, { type: 'passBid' }), 'Ben passes')
  h.ok(h.act(2, { type: 'passBid' }), 'Cho passes')
  h.ok(h.act(3, { type: 'passBid' }), 'Dara passes')
  h.eq(h.s.phase, 'ROLL', 'back to Asha for her doubles bonus roll')
  h.eq(h.s.props[5].owner, h.id(0), 'Asha won the auction')
  h.eq(h.p(0).cash, 1430, 'paid $70')
})

scenario('auction: last active player bidding closes it instantly (regression)', 4, (h) => {
  h.now(0)
  h.s.phase = 'ACTION'
  h.s.pendingPurchase = 6
  h.ok(h.act(0, { type: 'declineBuy' }), 'decline')
  for (const i of [1, 2, 3]) h.ok(h.act(i, { type: 'passBid' }), `p${i} passes`)
  h.ok(h.act(0, { type: 'bid', amount: 10 }), 'last active player bids')
  h.eq(h.s.auction, null, 'auction closed immediately — nobody left to outbid')
  h.eq(h.s.props[6].owner, h.id(0), 'bidder won')
  h.eq(h.s.phase, 'ACTION', 'turn continues for Asha to end')
})

scenario('auction: no bids → property stays with the bank', 4, (h) => {
  h.now(0)
  h.s.phase = 'ACTION'
  h.s.pendingPurchase = 6
  h.ok(h.act(0, { type: 'declineBuy' }), 'decline')
  for (const i of [0, 1, 2, 3]) h.ok(h.act(i, { type: 'passBid' }), `p${i} passes`)
  h.eq(h.s.props[6].owner, null, 'unsold')
  h.eq(h.s.phase, 'ACTION', 'turn flow resumes')
})

scenario('buy requires cash; decline is the fallback', 4, (h) => {
  h.cash(0, 50)
  h.now(0)
  h.s.phase = 'ACTION'
  h.s.pendingPurchase = 1 // Mediterranean, $60
  h.bad(h.act(0, { type: 'buy' }), 'cannot buy without cash')
  h.eq(allowedActions(h.s, h.id(0)).includes('buy'), false, 'buy not offered')
  h.eq(allowedActions(h.s, h.id(0)).includes('declineBuy'), true, 'auction is offered')
})

scenario('three doubles in a row → the arrest is announced, then executed', 4, (h) => {
  h.roll(0, [[3, 3]]) // → 6, unowned
  h.ok(h.act(0, { type: 'buy' }), 'buy Oriental')
  h.eq(h.s.phase, 'ROLL', 'doubles: roll again')
  h.roll(0, [[3, 3]]) // → 12, unowned
  h.ok(h.act(0, { type: 'declineBuy' }), 'decline Electric Co')
  for (const i of [0, 1, 2, 3]) h.ok(h.act(i, { type: 'passBid' }), `p${i} passes auction`)
  h.eq(h.s.phase, 'ROLL', 'second doubles: roll again')
  h.roll(0, [[3, 3]]) // third doubles → arrest announced
  h.eq(h.s.pendingJail != null && h.s.pendingJail.reason, 'doubles', 'the sentence is announced, not executed')
  h.eq(h.p(0).jail, false, 'not in jail yet — the phone button decides')
  h.eq(h.p(0).pos, 12, 'piece waits on its last landing spot until the tap')
  h.bad(h.act(1, { type: 'goToJail' }), 'only the arrested player can tap')
  h.bad(h.act(0, { type: 'endTurn' }), 'cannot end turn before the arrest')
  h.eq(allowedActions(h.s, h.id(0)).includes('goToJail'), true, 'the arrested phone shows the Go to Jail button')
  h.ok(h.act(0, { type: 'goToJail' }), 'tap Go to Jail')
  h.eq(h.p(0).jail, true, 'jailed')
  h.eq(h.p(0).pos, 10, 'in jail')
  h.eq(h.p(0).jailReason, 'rolled three doubles in a row', 'the reason is on record')
  h.eq(h.s.pendingJail, null, 'sentence executed')
  h.eq(h.s.phase, 'ACTION', 'turn ends after the arrest')
})

scenario('chance: "Go directly to Jail" — reveal first, then the arrest', 4, (h) => {
  h.s.chanceDeck = ['ch10']
  h.now(0)
  h.p(0).pos = 34
  h.roll(0, [[1, 1]]) // → 36 Chance
  h.ok(h.act(0, { type: 'drawCard' }), 'spin the wheel')
  h.eq(h.s.pendingCard != null && h.s.pendingCard.deck, 'chance', 'the reveal is in flight')
  h.eq(h.s.pendingJail != null && h.s.pendingJail.reason, 'card', 'the card announces the arrest')
  h.eq(h.p(0).pos, 34 + 2, 'piece waits while the reveal plays') // still on the chance tile (36)
  h.ok(h.act(0, { type: 'goToJail' }), 'tap Go to Jail after the reveal')
  h.eq(h.p(0).jail, true, 'jailed')
  h.eq(h.p(0).jailReason, 'the card says: Go directly to Jail', 'the card reason is on record')
  h.eq(h.p(0).cash, 1500, 'no GO money for card arrests')
})

scenario('jail: pay fine, use card, doubles escape, three failures', 4, (h) => {
  h.p(0).jail = true
  h.p(0).jailCards = 1
  h.now(0)
  h.ok(h.act(0, { type: 'useJailCard' }), 'use jail card')
  h.eq(h.p(0).jail, false, 'free')
  h.eq(h.p(0).jailCards, 0, 'card spent')
  h.eq(h.s.chanceDeck.includes('ch8'), true, 'card returned to the bottom of the deck')

  h.p(0).jail = true
  h.ok(h.act(0, { type: 'payJail' }), 'pay fine')
  h.eq(h.p(0).cash, 1450, '$50 gone')
  h.eq(h.p(0).jail, false, 'free again')

  h.p(0).jail = true
  h.p(0).pos = 10
  h.roll(0, [[4, 4]]) // doubles escape
  h.eq(h.p(0).jail, false, 'escaped via doubles')
  h.eq(h.p(0).pos, 18, 'moved the rolled amount')
  h.eq(h.s.phase, 'ACTION', 'doubles from jail do NOT grant another roll')

  h.p(0).jail = true
  h.p(0).pos = 10
  h.cash(0, 10)
  h.now(0)
  h.roll(0, [[1, 2]])
  h.eq(h.p(0).jailRolls, 1, 'first failure')
  h.now(0)
  h.roll(0, [[2, 3]])
  h.eq(h.p(0).jailRolls, 2, 'second failure')
  h.now(0)
  h.roll(0, [[3, 4]]) // third failure: forced $50 fine, can't afford → debt
  h.eq(h.s.phase, 'DEBT', 'owes the fine')
  h.eq(h.s.debt != null && h.s.debt.amount, 50, 'debt is the fine')
  h.eq(h.s.pendingMove, 7, 'move resumes after payment')
  h.give(0, [1])
  h.ok(h.act(0, { type: 'mortgage', space: 1 }), 'mortgage Mediterranean for $30')
  h.bad(h.act(0, { type: 'payDebt' }), 'still $20 short')
  h.give(0, [3])
  h.ok(h.act(0, { type: 'mortgage', space: 3 }), 'mortgage Baltic for $30')
  h.ok(h.act(0, { type: 'payDebt' }), 'fine settled')
  h.eq(h.p(0).pos, 17, 'the move completed: 10 + 7')
  h.eq(h.s.debt, null, 'debt cleared')
  h.eq(h.s.phase, 'ACTION', 'turn continues')
})

scenario('go to jail space: announced, then executed, no GO money', 4, (h) => {
  h.now(0)
  h.p(0).pos = 27
  h.roll(0, [[2, 1]]) // → 30
  h.eq(h.s.pendingJail != null && h.s.pendingJail.reason, 'space', 'landing announces the arrest')
  h.eq(h.p(0).pos, 30, 'piece waits on the Go To Jail tile until the tap')
  h.eq(h.p(0).cash, 1500, 'no GO money on the way to the arrest')
  h.ok(h.act(0, { type: 'goToJail' }), 'tap Go to Jail')
  h.eq(h.p(0).pos, 10, 'jailed')
  h.eq(h.p(0).jail, true, 'in jail')
  h.eq(h.p(0).jailReason, 'landed on Go To Jail', 'the reason is on record')
  h.eq(h.p(0).cash, 1500, 'still no GO money')
})

scenario('chance: nearest railroad charges double rent', 4, (h) => {
  h.give(1, [15])
  h.s.chanceDeck = ['ch4']
  h.now(0)
  h.p(0).pos = 5
  h.roll(0, [[1, 1]]) // → 7 Chance
  h.eq(h.s.pendingCardDraw != null && h.s.pendingCardDraw.deck, 'chance', 'landing prompts the wheel, not an instant draw')
  h.eq(allowedActions(h.s, h.id(0)).includes('drawCard'), true, 'the drawer is offered the spin')
  h.eq(allowedActions(h.s, h.id(1)).includes('drawCard'), false, 'nobody else can spin for them')
  h.bad(h.act(0, { type: 'endTurn' }), 'cannot end turn before drawing')
  h.ok(h.act(0, { type: 'drawCard' }), 'spin the wheel')
  h.eq(h.s.cardDrawSeq, 1, 'reveal counted for animations')
  h.eq(h.p(0).pos, 15, 'advanced to the railroad')
  h.eq(h.s.phase, 'DEBT', 'the railroad rent is a pending debt')
  h.ok(h.act(0, { type: 'payDebt' }), 'double rent paid by hand')
  h.eq(h.p(0).cash, 1450, 'paid 2× the single-rail rent ($50)')
  h.eq(h.p(1).cash, 1550, 'owner collected')
  h.eq(h.s.phase, 'ROLL', 'doubles on the movement roll: Asha rolls again')
  h.eq(allowedActions(h.s, h.id(0)).includes('roll'), true, 'the bonus roll is offered')
})

scenario('chance: nearest utility charges 10× a fresh roll', 4, (h) => {
  h.give(1, [28])
  h.s.chanceDeck = ['ch6']
  h.now(0)
  h.p(0).pos = 20
  h.roll(0, [[1, 1]]) // → 22 Chance, then fresh utility roll 5+2
  h.ok(h.act(0, { type: 'drawCard' }, [[5, 2]]), 'spin') // the rigged pair feeds the fresh roll
  h.eq(h.p(0).pos, 28, 'advanced to Water Works')
  h.eq(h.s.lastMove != null && h.s.lastMove.path, [23, 24, 25, 26, 27, 28], 'the stroll to the utility is recorded tile-by-tile for the TV')
  h.ok(h.act(0, { type: 'payDebt' }), 'utility rent paid by hand')
  h.eq(h.p(0).cash, 1430, 'paid 10 × 7 = $70')
})

scenario('chance: advance to Illinois crosses GO and pays $200', 4, (h) => {
  h.s.chanceDeck = ['ch2']
  h.now(0)
  h.p(0).pos = 34
  h.roll(0, [[1, 1]]) // → 36 Chance → Illinois (24)
  h.ok(h.act(0, { type: 'drawCard' }), 'spin')
  h.eq(h.p(0).pos, 24, 'advanced to Illinois Ave')
  h.eq(h.s.lastMove != null && h.s.lastMove.path.length, 28, 'a 28-tile wrap stroll around the board')
  h.eq(h.s.lastMove != null && h.s.lastMove.path[27], 24, 'ending on Illinois')
  h.eq(h.p(0).cash, 1700, 'collected GO money on the wrap')
})

scenario('chance: go back 3 spaces chains into Community Chest', 4, (h) => {
  h.s.chanceDeck = ['ch9']
  h.s.chestDeck = ['cc12'] // hospital fees $100
  h.now(0)
  h.p(0).pos = 34
  h.roll(0, [[1, 1]]) // → 36 Chance
  h.ok(h.act(0, { type: 'drawCard' }), 'spin the wheel')
  h.eq(h.p(0).pos, 33, 'back 3 onto Community Chest')
  h.eq(h.s.lastMove != null && h.s.lastMove.path, [35, 34, 33], 'backward moves record their path in walk order')
  h.eq(h.s.pendingCardDraw != null && h.s.pendingCardDraw.deck, 'chest', 'the chained chest also prompts')
  h.ok(h.act(0, { type: 'drawCard' }), 'open the chained chest')
  h.eq(h.s.phase, 'DEBT', 'the hospital fee waits for a tap — no silent deduction')
  h.eq(h.s.debt != null && h.s.debt.memo, 'Card: Hospital fees. Pay $100.', 'the memo rides along to the phone')
  h.eq(h.p(0).cash, 1500, 'the wallet is untouched until the tap')
  h.ok(h.act(0, { type: 'payDebt' }), 'pay the fee')
  h.eq(h.p(0).cash, 1400, 'drew and paid the chest card')
  h.eq(h.s.pendingCard != null && h.s.pendingCard.deck, 'chest', 'the chained chest card is showing')
  h.eq(h.s.cardDrawSeq, 2, 'both reveals counted')
})

scenario('chance: repairs card counts houses and hotels', 4, (h) => {
  h.give(0, [1, 6])
  h.prop(1, { houses: 2 })
  h.prop(6, { houses: 5 }) // hotel
  h.s.chanceDeck = ['ch11']
  h.now(0)
  h.p(0).pos = 34
  h.roll(0, [[1, 1]]) // → 36 Chance: $25/house, $100/hotel
  h.ok(h.act(0, { type: 'drawCard' }), 'spin')
  h.eq(h.s.phase, 'DEBT', 'the repair bill arrives as a prompt, not a skim')
  h.eq(h.s.debt != null && h.s.debt.amount, 150, '2 houses and a hotel')
  h.eq(h.s.debt != null && h.s.debt.memo, 'Card: Make general repairs: pay $25 per house, $100 per hotel.', 'the memo names the card')
  h.eq(h.p(0).cash, 1500, 'cash untouched until the tap')
  h.ok(h.act(0, { type: 'payDebt' }), 'pay the repairs by hand')
  h.eq(h.p(0).cash, 1500 - 2 * 25 - 100, 'paid $150 in repairs')
})

scenario('even building and selling; mortgages need empty groups', 4, (h) => {
  h.give(0, [1, 3])
  h.ok(h.act(0, { type: 'buyHouse', space: 1 }), 'first house on Mediterranean')
  h.bad(h.act(0, { type: 'buyHouse', space: 1 }), 'cannot build unevenly')
  h.ok(h.act(0, { type: 'buyHouse', space: 3 }), 'catch up on Baltic')
  h.ok(h.act(0, { type: 'buyHouse', space: 1 }), 'even again: may build')
  h.bad(h.act(0, { type: 'mortgage', space: 3 }), 'cannot mortgage with buildings standing')
  h.ok(h.act(0, { type: 'sellHouse', space: 1 }), 'sell from the most-developed first')
  h.ok(h.act(0, { type: 'sellHouse', space: 3 }), 'then the other')
  h.ok(h.act(0, { type: 'sellHouse', space: 1 }), 'empty the last house')
  h.bad(h.act(0, { type: 'sellHouse', space: 3 }), 'nothing left to sell')
  h.ok(h.act(0, { type: 'mortgage', space: 3 }), 'empty group may mortgage')
  h.bad(h.act(0, { type: 'buyHouse', space: 1 }), 'cannot build while the group has a mortgage')
})

scenario('mortgage math is exact (no float drift)', 4, (h) => {
  h.give(0, [8]) // Vermont, $100
  h.ok(h.act(0, { type: 'mortgage', space: 8 }), 'mortgage for $50')
  h.eq(h.p(0).cash, 1550, 'received half')
  h.ok(h.act(0, { type: 'unmortgage', space: 8 }), 'lift mortgage')
  h.eq(h.p(0).cash, 1495, 'paid 110% of $50 — exactly $55')
})

scenario('debt resolution: raise funds, then pay — with a queue', 4, (h) => {
  // Birthday card: $10 from every player. Always-outflow makes this a
  // relay — Ben pays by hand first, and only then does the drawer collect;
  // the short seats follow on their own clocks.
  h.s.chestDeck = ['cc10']
  h.cash(2, 5)
  h.cash(3, 3)
  h.give(2, [11])
  h.give(3, [13])
  h.now(0)
  h.p(0).pos = 15
  h.roll(0, [[1, 1]]) // → 17 Chest
  h.ok(h.act(0, { type: 'drawCard' }), 'open the chest')
  h.eq(h.s.phase, 'DEBT', 'the first payer is prompted — nobody is skimmed silently')
  h.eq(h.s.debt != null && h.s.debt.debtor, h.id(1), 'Ben is up first')
  h.eq(h.s.debtQueue.length, 2, 'Cho and Dara queue behind him')
  h.eq(h.p(0).cash, 1500, 'the drawer collects nothing before the taps')
  h.eq(allowedActions(h.s, h.id(2)).length, 0, 'queued debtors are frozen until it is their row')
  h.ok(h.act(1, { type: 'payDebt' }), 'Ben taps Pay')
  h.eq(h.p(0).cash, 1510, 'the drawer collects inline')
  h.eq(h.p(1).cash, 1490, 'and Ben is $10 lighter')
  h.eq(h.s.debt != null && h.s.debt.debtor, h.id(2), 'Cho\u2019s debt activates next')
  h.eq(allowedActions(h.s, h.id(1)).length, 0, 'Ben is frozen while Cho raises funds')
  h.ok(h.act(2, { type: 'mortgage', space: 11 }), 'Cho mortgages St. Charles')
  h.ok(h.act(2, { type: 'payDebt' }), 'and pays')
  h.eq(h.s.phase, 'DEBT', 'the queued debt (Dara) is now active')
  h.ok(h.act(3, { type: 'mortgage', space: 13 }), 'Dara mortgages States')
  h.ok(h.act(3, { type: 'payDebt' }), 'and pays')
  h.eq(h.p(0).cash, 1530, 'drawer collected from everyone in the end')
  h.eq(h.s.debt, null, 'no debts left')
  h.eq(h.s.phase, 'ROLL', 'doubles on the birthday roll: Asha rolls again')
})

scenario('bankruptcy to a player: estate, interest, jail cards, trades', 4, (h) => {
  h.give(0, [1, 3, 6])
  h.prop(1, { houses: 2 }) // liquidates for 2 × $50/2 = $50
  h.prop(6, { houses: 5 }) // hotel liquidates for 5 × $50/2 = $125
  h.prop(3, { mortgaged: true })
  h.cash(0, 30)
  h.cash(1, 100)
  h.p(0).jailCards = 1
  h.s.trades.push({ id: 't1', from: h.id(0), to: h.id(2), give: { cash: 0, spaces: [], jailCards: 0 }, receive: { cash: 0, spaces: [], jailCards: 0 } })
  h.s.debt = { debtor: h.id(0), amount: 500, creditor: h.id(1) }
  h.s.phase = 'DEBT'
  h.ok(h.act(0, { type: 'bankrupt' }), 'declare bankruptcy')
  h.eq(h.p(0).bankrupt, true, 'bankrupt')
  h.eq(h.p(0).cash, 0, 'wiped out')
  // 100 + 30 cash + 175 liquidation − 6 interest on the mortgaged Baltic
  h.eq(h.p(1).cash, 299, 'creditor got the estate, paid 10% interest on the mortgage')
  h.eq(h.s.props[1].owner, h.id(1), 'deeds transferred')
  h.eq(h.s.props[1].houses, 0, 'buildings liquidated')
  h.eq(h.p(1).jailCards, 1, 'jail cards transferred')
  h.eq(h.s.trades.length, 0, 'the bankrupt player\u2019s pending trades were voided')
  h.eq(h.s.phase, 'ROLL', 'play continues')
  h.eq(h.s.currentPlayerId, h.id(1), 'next player up')
})

scenario('bankruptcy to the bank puts properties under the hammer', 3, (h) => {
  h.give(0, [6, 11])
  h.cash(0, 10)
  h.s.debt = { debtor: h.id(0), amount: 999, creditor: null }
  h.s.phase = 'DEBT'
  h.ok(h.act(0, { type: 'bankrupt' }), 'bankrupt to the bank')
  h.eq(h.s.props[6].owner, null, 'property 6 back with the bank')
  h.eq(h.s.auctionQueue.includes(11), true, 'property 11 queued for auction')
  h.eq(h.s.phase, 'AUCTION', 'liquidation auction running')
  const first = h.s.auction != null ? h.s.auction.space : null
  for (const i of [1, 2]) h.ok(h.act(i, { type: 'passBid' }), `p${i} passes`)
  h.bad(h.act(0, { type: 'bid', amount: 10 }), 'the bankrupt cannot bid')
  // Asha is gone; the remaining two passing closes the first auction,
  // the second one opens automatically.
  h.eq(h.s.auction != null && h.s.auction.space !== first, true, 'second auction started')
  h.ok(h.act(1, { type: 'bid', amount: 20 }), 'Ben bids')
  h.ok(h.act(2, { type: 'passBid' }), 'Cho passes')
  h.eq(h.s.phase, 'ROLL', 'liquidations done — next player\u2019s turn')
  h.eq(h.s.currentPlayerId, h.id(1), 'Ben is up (bankrupt Asha is skipped)')
})

scenario('transaction ledger records every cash movement', 4, (h) => {
  h.give(1, [1])
  h.give(0, [3])
  h.now(0)
  h.p(0).pos = 38
  h.roll(0, [[1, 2]]) // sum 3 → wraps GO → lands on 1, owned by Ben
  h.ok(h.act(0, { type: 'payDebt' }), 'pays the rent by hand')
  const p0Ledger = h.s.ledger.filter((e) => e.playerId === h.id(0))
  const p1Ledger = h.s.ledger.filter((e) => e.playerId === h.id(1))
  h.eq(p0Ledger.length, 2, 'Asha: GO money + rent')
  h.eq(p0Ledger[0].memo, 'Passed GO', 'GO reward is itemised')
  h.eq(p0Ledger[0].balance, 1700, 'balance recorded after GO: $1,700')
  h.eq(p0Ledger[1].delta, -2, 'rent recorded as a payment')
  h.eq(p0Ledger[1].balance, 1698, 'balance after rent: $1,698')
  h.eq(p0Ledger[1].memo, 'Rent: Mediterranean Ave', 'rent memo names the space')
  h.eq(p1Ledger.length, 1, 'Ben: rent received')
  h.eq(p1Ledger[0].delta, 2, 'and it is the same $2')
  h.eq(p1Ledger[0].balance, 1502, 'creditor balance recorded too')
  h.eq(p1Ledger[0].memo, 'Received from Asha: Rent: Mediterranean Ave', 'creditor memo names the payer')

  h.ok(h.act(0, { type: 'mortgage', space: 3 }), 'mortgage Baltic')
  h.eq(h.s.ledger.filter((e) => e.playerId === h.id(0) && e.memo === 'Mortgaged Baltic Ave').length, 1, 'mortgage recorded')
  h.eq(
    h.s.ledger.find((e) => e.playerId === h.id(0) && e.memo === 'Mortgaged Baltic Ave')?.balance,
    1728,
    'balance after the mortgage: $1,728',
  )
})

scenario('bankrupt players are skipped in turn order', 4, (h) => {
  h.p(1).bankrupt = true
  h.now(0, 'ACTION')
  h.ok(h.act(0, { type: 'endTurn' }), 'end turn')
  h.eq(h.s.currentPlayerId, h.id(2), 'Cho is next — Ben is skipped')
})

scenario('two-player game: bankruptcy ends it', 2, (h) => {
  h.cash(0, 10)
  h.s.debt = { debtor: h.id(0), amount: 999, creditor: h.id(1) }
  h.s.phase = 'DEBT'
  h.ok(h.act(0, { type: 'bankrupt' }), 'bankrupt')
  h.eq(h.s.phase, 'GAME_OVER', 'game over')
  h.eq(h.s.winner, h.id(1), 'Ben wins')
})

scenario('trades: happy path, building block, wrong responder', 4, (h) => {
  h.give(0, [1])
  h.give(1, [6])
  h.ok(
    h.act(0, { type: 'proposeTrade', to: h.id(1), give: { cash: 100, spaces: [1], jailCards: 0 }, receive: { cash: 0, spaces: [6], jailCards: 0 } }),
    'propose a trade',
  )
  h.bad(
    h.act(2, { type: 'respondTrade', tradeId: h.s.trades[0]!.id, accept: true }),
    'only the recipient can respond',
  )
  h.ok(
    h.act(1, { type: 'respondTrade', tradeId: h.s.trades[0]!.id, accept: true }),
    'accept',
  )
  h.eq(h.s.props[1].owner, h.id(1), 'Mediterranean is Ben\u2019s now')
  h.eq(h.s.props[6].owner, h.id(0), 'Oriental is Asha\u2019s now')
  h.eq(h.p(0).cash, 1400, 'Asha paid $100')
  h.eq(h.p(1).cash, 1600, 'Ben received it')

  // buildings block trading the whole group
  h.give(2, [11, 13, 14])
  h.prop(13, { houses: 1 })
  h.bad(
    h.act(2, { type: 'proposeTrade', to: h.id(3), give: { cash: 0, spaces: [11], jailCards: 0 }, receive: { cash: 0, spaces: [], jailCards: 0 } }),
    'cannot trade property whose group has buildings',
  )
})

scenario('trade invalidated between offer and acceptance', 4, (h) => {
  h.give(0, [1])
  h.give(1, [3])
  h.ok(
    h.act(0, { type: 'proposeTrade', to: h.id(1), give: { cash: 0, spaces: [1], jailCards: 0 }, receive: { cash: 0, spaces: [3], jailCards: 0 } }),
    'offer made',
  )
  h.prop(1, { houses: 2 }) // sneak buildings onto the offered group
  h.bad(
    h.act(1, { type: 'respondTrade', tradeId: h.s.trades[0]!.id, accept: true }),
    'acceptance revalidates',
  )
  h.eq(h.s.trades.length, 0, 'stale offer removed')
  h.eq(h.s.props[1].owner, h.id(0), 'nothing changed hands')
})

scenario('jail cards leave and return to their decks', 4, (h) => {
  h.s.chanceDeck = ['ch8']
  h.now(0)
  h.p(0).pos = 5
  h.roll(0, [[1, 1]]) // → 7 Chance → Get Out of Jail Free
  h.ok(h.act(0, { type: 'drawCard' }), 'spin')
  h.eq(h.p(0).jailCards, 1, 'card kept')
  h.eq(h.s.chanceDeck.includes('ch8'), false, 'removed from the deck while held')
  h.p(0).jail = true
  h.now(0)
  h.ok(h.act(0, { type: 'useJailCard' }), 'use it later')
  h.eq(h.s.chanceDeck.includes('ch8'), true, 'returned to the deck')
})

scenario('allowed actions gate everything (tamper-proof reducer)', 4, (h) => {
  h.bad(h.act(1, { type: 'roll' }), 'not your turn')
  h.bad(h.act(1, { type: 'endTurn' }), 'not your turn to end')
  h.bad(h.act(1, { type: 'buy' }), 'nothing to buy')
  h.bad(h.act(1, { type: 'buyHouse', space: 1 }), 'you do not own that')
  h.bad(h.act(1, { type: 'mortgage', space: 999 }), 'no such space')
  h.bad(h.act(1, { type: 'payDebt' }), 'no debt')
  h.bad(h.act(1, { type: 'bankrupt' }), 'not in debt')
  h.bad(h.act(1, { type: 'goToJail' }), 'no arrest pending')
  h.bad(h.act(1, { type: 'respondTrade', tradeId: 'nope', accept: true }), 'no such offer')
  h.bad(h.act(1, { type: 'bid', amount: 5 }), 'no auction running')
  h.eq(allowedActions(h.s, h.id(1)).includes('roll'), false, 'only the current player rolls')
  h.eq(allowedActions(h.s, h.id(0)).includes('roll'), true, 'the current player may roll')
  h.eq(allowedActions(h.s, 'ghost').length, 0, 'unknown player')
})

scenario('bankruptcy on the third failed jail roll ends the turn cleanly', 4, (h) => {
  h.now(0)
  h.p(0).jail = true
  h.p(0).jailRolls = 2
  h.cash(0, 30) // can't cover the $50 fine
  const posBefore = h.p(0).pos
  h.ok(h.roll(0, [[2, 3]]), 'third failed jail roll')
  h.eq(h.s.phase, 'DEBT', 'owe the fine')
  h.eq(h.s.pendingMove, 5, 'move parked until the fine is settled')
  h.ok(h.act(0, { type: 'bankrupt' }), 'declare bankruptcy')
  h.eq(h.p(0).bankrupt, true, 'out of the game')
  h.eq(h.p(0).pos, posBefore, 'the dead piece never finished its stroll')
  h.eq(h.p(0).cash, 0, 'estate wiped — no GO salary on the way out')
  h.eq(h.s.pendingMove, null, 'no parked move left behind')
  h.eq(h.s.pendingPurchase, null, 'no landing offer left behind')
  h.eq(h.s.phase, 'ROLL', 'the turn passed on')
  h.eq(h.s.currentPlayerId, 'p1', 'next player is up')
  h.eq(allowedActions(h.s, 'p1').includes('roll'), true, 'the game is still live')
})

scenario('a used jail card returns to the deck it came from', 4, (h) => {
  // p0 draws the Chance jail card, p1 the Chest one — both cards are out.
  h.s.chanceDeck = ['ch8']
  h.now(0)
  h.p(0).pos = 5
  h.roll(0, [[1, 1]]) // → 7, Chance
  h.ok(h.act(0, { type: 'drawCard' }), 'p0 draws the chance jail card')
  h.eq(h.p(0).jailCards, 1, 'p0 holds it')

  h.s.chestDeck = ['cc5']
  h.now(1)
  h.p(1).pos = 15
  h.roll(1, [[1, 1]]) // → 17, Community Chest
  h.ok(h.act(1, { type: 'drawCard' }), 'p1 draws the chest jail card')
  h.eq(h.p(1).jailCards, 1, 'p1 holds one too')

  // p1 uses theirs while p0's chance card is still out. "The deck that's
  // missing its card" would put the CHANCE card back in play — duplicating
  // it and losing the chest one forever. It must return to the CHEST deck.
  h.p(1).jail = true
  h.now(1)
  h.ok(h.act(1, { type: 'useJailCard' }), 'p1 uses theirs')
  h.eq(h.s.chestDeck.includes('cc5'), true, 'returned to the chest deck it came from')
  h.eq(h.s.chanceDeck.includes('ch8'), false, 'the chance card stays in p0\u2019s hand — not duplicated')
  h.eq(h.p(0).jailCards, 1, 'p0 still holds theirs')
})

scenario('the bank repossesses bankrupt properties unmortgaged', 4, (h) => {
  h.give(0, [1])
  h.prop(1, { mortgaged: true })
  h.now(0)
  h.cash(0, 0)
  h.s.debt = { debtor: 'p0', amount: 500, creditor: null }
  h.s.phase = 'DEBT'
  h.ok(h.act(0, { type: 'bankrupt' }), 'bankrupt to the bank')
  h.eq(h.s.props[1].owner, null, 'property back with the bank')
  h.eq(h.s.props[1].mortgaged, false, 'repossessed clean — the auction sells a live deed')
})

scenario('trades: decline works mid-auction; accept pauses politely', 4, (h) => {
  // a standing offer, made while the table was live
  h.ok(
    h.act(1, { type: 'proposeTrade', to: h.id(2), give: { cash: 10, spaces: [], jailCards: 0 }, receive: { cash: 0, spaces: [], jailCards: 0 } }),
    'offer on the table before the freeze',
  )
  // freeze the table on an auction
  h.now(0)
  h.s.phase = 'ACTION'
  h.s.pendingPurchase = 6
  h.ok(h.act(0, { type: 'declineBuy' }), 'decline sends the property under the hammer')
  h.eq(h.s.phase, 'AUCTION', 'auction running')
  h.eq(allowedActions(h.s, h.id(2)).includes('respondTrade'), true, 'the offeree can still respond mid-auction')
  h.eq(allowedActions(h.s, h.id(3)).includes('respondTrade'), false, 'bystanders with no offer get no button')
  h.bad(
    h.act(2, { type: 'respondTrade', tradeId: h.s.trades[0]!.id, accept: true }),
    'accept politely refuses mid-auction',
  )
  h.eq(h.s.trades.length, 1, 'the refused accept kept the offer alive')
  h.ok(
    h.act(2, { type: 'respondTrade', tradeId: h.s.trades[0]!.id, accept: false }),
    'decline succeeds mid-auction',
  )
  h.eq(h.s.trades.length, 0, 'offer removed')
})

scenario('trades: decline works during a debt freeze', 4, (h) => {
  h.s.trades.push({ id: 't1', from: h.id(1), to: h.id(2), give: { cash: 5, spaces: [], jailCards: 0 }, receive: { cash: 0, spaces: [], jailCards: 0 } })
  h.s.debt = { debtor: h.id(0), amount: 500, creditor: null }
  h.s.phase = 'DEBT'
  h.eq(allowedActions(h.s, h.id(2)).includes('respondTrade'), true, 'the offeree can respond during the freeze')
  h.eq(allowedActions(h.s, h.id(0)).includes('respondTrade'), false, 'the debtor only gets their funding actions')
  h.bad(h.act(2, { type: 'respondTrade', tradeId: 't1', accept: true }), 'accept politely refuses during the freeze')
  h.eq(h.s.trades.length, 1, 'offer kept')
  h.ok(h.act(2, { type: 'respondTrade', tradeId: 't1', accept: false }), 'decline succeeds during the freeze')
  h.eq(h.s.trades.length, 0, 'offer removed')
})

scenario('trades: withdraw works mid-auction', 4, (h) => {
  h.ok(
    h.act(1, { type: 'proposeTrade', to: h.id(2), give: { cash: 10, spaces: [], jailCards: 0 }, receive: { cash: 0, spaces: [], jailCards: 0 } }),
    'offer on the table before the freeze',
  )
  h.now(0)
  h.s.phase = 'ACTION'
  h.s.pendingPurchase = 6
  h.ok(h.act(0, { type: 'declineBuy' }), 'decline starts the auction')
  h.eq(h.s.phase, 'AUCTION', 'auction running')
  h.eq(allowedActions(h.s, h.id(1)).includes('cancelTrade'), true, 'the offerer can withdraw mid-auction')
  h.ok(h.act(1, { type: 'cancelTrade', tradeId: h.s.trades[0]!.id }), 'withdraw succeeds mid-auction')
  h.eq(h.s.trades.length, 0, 'offer withdrawn')
  h.eq(h.s.phase, 'AUCTION', 'the auction itself is untouched')
})

// ── Forfeit: the one estate rule ──

scenario('forfeit mid-own-turn advances cleanly', 4, (h) => {
  h.now(0) // Asha's turn, plain ROLL phase, no holdings
  h.ok(forfeitEstate(h.s, h.id(0)), 'forfeit')
  h.eq(h.p(0).bankrupt, true, 'out of the game')
  h.eq(h.p(0).cash, 0, 'estate wiped')
  h.eq(h.s.currentPlayerId, h.id(1), 'the turn passed to Ben')
  h.eq(h.s.phase, 'ROLL', 'a live phase for the next player')
  h.eq(allowedActions(h.s, h.id(1)).includes('roll'), true, 'the game keeps moving')
  h.bad(h.act(0, { type: 'roll' }), 'the gone player cannot act')
})

scenario('forfeit puts their deeds under the hammer unmortgaged', 4, (h) => {
  h.now(0)
  h.give(0, [1, 6])
  h.prop(1, { mortgaged: true })
  h.prop(6, { houses: 3 })
  h.ok(forfeitEstate(h.s, h.id(0), 'Asha left the party — their properties go under the hammer'), 'forfeit')
  h.eq(h.s.props[1].owner, null, 'the bank holds the deed')
  h.eq(h.s.props[1].mortgaged, false, 'repossessed clean — the auction sells a live deed')
  h.eq(h.s.props[6].houses, 0, 'buildings liquidated to the bank')
  const firstUnderHammer = h.s.auction != null ? h.s.auction.space : null
  const secondQueued = h.s.auctionQueue[0] ?? null
  h.eq(
    (firstUnderHammer === 1 && secondQueued === 6) || (firstUnderHammer === 6 && secondQueued === 1),
    true,
    'one deed under the hammer right now, the other queued next',
  )
  h.eq(h.s.phase, 'AUCTION', 'the hammer falls immediately')
  h.eq(h.s.log.some((e) => e.text.includes('left the party — their properties go under the hammer')), true, 'the walk-out is on the record')
  // the two liquidation auctions settle (everyone passes → bank keeps both)
  for (let k = 0; k < 2; k++) {
    for (const i of [1, 2, 3]) h.ok(h.act(i, { type: 'passBid' }), `auction ${k + 1}: p${i} passes`)
  }
  h.eq(h.s.phase, 'ROLL', 'liquidations done — the turn advanced past the bankrupt seat')
  h.eq(h.s.currentPlayerId, h.id(1), 'Ben is up')
})

scenario('forfeit voids their trades and returns their jail cards', 4, (h) => {
  h.p(0).jailCards = 1
  h.p(0).jailCardDecks = ['chance']
  h.s.chanceDeck = h.s.chanceDeck.filter((id) => id !== 'ch8') // the card is out in a hand
  h.s.trades.push({ id: 't1', from: h.id(0), to: h.id(1), give: { cash: 0, spaces: [], jailCards: 0 }, receive: { cash: 0, spaces: [], jailCards: 0 } })
  h.s.trades.push({ id: 't2', from: h.id(1), to: h.id(2), give: { cash: 0, spaces: [], jailCards: 0 }, receive: { cash: 0, spaces: [], jailCards: 0 } })
  h.ok(forfeitEstate(h.s, h.id(0)), 'forfeit')
  h.eq(h.s.trades.length, 1, "only the leaver's offers died")
  h.eq(h.s.trades[0]!.id, 't2', 'the bystander offer survives')
  h.eq(h.p(0).jailCards, 0, 'cards out of their hand')
  h.eq(h.s.chanceDeck.includes('ch8'), true, 'the chance jail card is back in its own deck')
})

scenario('forfeit with a pending player-debt pays the lender', 4, (h) => {
  h.give(0, [1, 3, 6])
  h.prop(3, { mortgaged: true })
  h.cash(0, 30)
  h.cash(1, 100)
  h.p(0).jailCards = 1
  h.p(0).jailCardDecks = ['chance']
  h.s.debt = { debtor: h.id(0), amount: 500, creditor: h.id(1) }
  h.s.phase = 'DEBT'
  // the rooms layer routes this case through forfeitSeat → declareBankruptcy
  h.ok(forfeitSeat(h.s, h.id(0), 'Asha left the party'), 'the estate settles through the routing the server uses')
  h.eq(h.p(0).bankrupt, true, 'out of the game')
  // 100 + 30 cash − 6 interest on the mortgaged Baltic
  h.eq(h.p(1).cash, 124, 'the lender got the estate, paid 10% interest on the mortgage')
  h.eq(h.s.props[1].owner, h.id(1), 'deeds transferred to the creditor')
  h.eq(h.p(1).jailCards, 1, 'jail cards transferred')
  h.eq(h.s.debt, null, 'the debt died with the estate')
})

scenario('forfeit leaving one alive ends the game automatically', 2, (h) => {
  h.give(0, [1])
  h.ok(forfeitEstate(h.s, h.id(0)), 'forfeit')
  h.eq(h.s.phase, 'GAME_OVER', 'the game ended with no host intervention')
  h.eq(h.s.winner, h.id(1), 'Ben wins')
  h.eq(h.s.auctionQueue.length, 0, 'no auctions needed — the game is over')
  h.eq(h.s.props[1].owner, null, 'the deed went back to the bank')
  h.eq(h.s.log[h.s.log.length - 1]?.text, '🏆 Ben WINS — last one standing!', 'the walk-off victory is logged its own way')
})

scenario('forfeit never bails out the current player', 4, (h) => {
  // A is mid buy-decision; B walks out — A's decision must survive
  h.give(0, [1])
  h.now(0, 'ACTION')
  h.s.pendingPurchase = 1
  h.ok(forfeitSeat(h.s, h.id(1), 'Ben left the party'), 'a bystander forfeits')
  h.eq(h.s.pendingPurchase, 1, "Asha's live buy decision survives")
  h.eq(allowedActions(h.s, h.id(0)).includes('buy'), true, 'Asha can still buy')

  // A is under an announced arrest; C walks out — A must still go to jail
  h.s.pendingPurchase = null
  h.s.pendingJail = { player: h.id(0), reason: 'card' }
  h.ok(forfeitSeat(h.s, h.id(2), 'Cho left the party'), 'another bystander forfeits')
  h.eq(h.s.pendingJail != null && h.s.pendingJail.player, h.id(0), "Asha's arrest survives")
  h.eq(allowedActions(h.s, h.id(0)).includes('goToJail'), true, 'Asha must still go to jail')
})

scenario('forfeit redirects debts the leaver was collecting', 4, (h) => {
  // Asha owes Ben rent; Ben walks out — the debt pays the bank, not a corpse
  h.s.debt = { debtor: h.id(0), amount: 25, creditor: h.id(1), memo: 'Rent: Test Ave' }
  h.s.phase = 'DEBT'
  h.cash(1, 200)
  h.ok(forfeitSeat(h.s, h.id(1), 'Ben left the party'), 'the creditor forfeits')
  h.eq(h.s.debt != null && h.s.debt.creditor, null, 'the debt now pays the bank')
  h.ok(h.act(0, { type: 'payDebt' }), 'Asha pays')
  h.eq(h.p(0).cash, 1475, 'Asha paid the 25 (1500 − 25)')
  h.eq(h.p(1).cash, 0, 'no cash landed on the dead seat')
})

scenario('a disconnect is not a forfeit: the seat waits', 4, (h) => {
  h.p(1).connected = false // the phone dropped — no room:leave ever arrived
  h.eq(h.p(1).bankrupt, false, 'the seat is intact and rejoinable')
  h.eq(h.s.phase, 'ROLL', 'the engine state is untouched')
  h.eq(h.s.winner, null, 'no automatic winner')
  h.ok(h.roll(0, [[1, 2]]), 'the game plays on without them')
  h.eq(h.s.phase, 'ACTION', 'a fresh landing is live for the current player')
})

// ── Prompt before money leaves ──

scenario('luxury tax prompts before the cash leaves', 4, (h) => {
  h.now(0)
  h.p(0).pos = 36
  h.roll(0, [[1, 1]]) // → 38 Luxury Tax ($75)
  h.eq(h.s.phase, 'DEBT', 'the tax is a prompt, not a deduction')
  h.eq(h.s.debt != null && h.s.debt.amount, 75, 'the full luxury tax is named')
  h.eq(h.s.debt != null && h.s.debt.memo, 'Luxury tax', 'charge() preserves the memo')
  h.eq(h.s.debt != null && h.s.debt.creditor, null, 'the bank is the creditor')
  h.eq(h.p(0).cash, 1500, 'nothing has left the wallet yet')
  h.ok(h.act(0, { type: 'payDebt' }), 'one named tap pays it')
  h.eq(h.p(0).cash, 1425, 'the money left on the tap')
  const last = h.s.ledger[h.s.ledger.length - 1]
  h.eq(last != null && last.memo, 'Luxury tax', 'ledger memo byte-identical to the old instant path')
  h.eq(last != null && last.delta, -75, 'recorded as a payment')
  h.eq(last != null && last.balance, 1425, 'post-transaction balance')
  h.eq(h.s.phase, 'ROLL', 'the doubles chain continues after the payment')
})

scenario('a card fee prompts before the cash leaves', 4, (h) => {
  h.s.chestDeck = ['cc13'] // School fees. Pay $50.
  h.now(0)
  h.p(0).pos = 15
  h.roll(0, [[1, 1]]) // → 17 Chest
  h.ok(h.act(0, { type: 'drawCard' }), 'open the chest')
  h.eq(h.s.phase, 'DEBT', 'the school fee arrives as a prompt')
  h.eq(h.s.debt != null && h.s.debt.amount, 50, 'the card amount')
  h.eq(h.s.debt != null && h.s.debt.memo, 'Card: School fees. Pay $50.', 'the card memo rides along')
  h.eq(h.s.debt != null && h.s.debt.creditor, null, 'a pay card bills the bank')
  h.eq(h.p(0).cash, 1500, 'cash untouched before the tap')
  h.ok(h.act(0, { type: 'payDebt' }), 'tap to pay')
  h.eq(h.p(0).cash, 1450, 'paid on the tap')
  h.eq(h.s.ledger[h.s.ledger.length - 1]?.memo, 'Card: School fees. Pay $50.', 'ledger memo byte-identical')
})

scenario('birthday relay: three solvent payers, sequential prompts', 4, (h) => {
  h.s.chestDeck = ['cc10'] // It's your birthday. Collect $10 from every player.
  h.now(0)
  h.p(0).pos = 15
  h.roll(0, [[1, 1]]) // → 17 Chest
  h.ok(h.act(0, { type: 'drawCard' }), 'open the chest')
  h.eq(h.s.phase, 'DEBT', 'the first payer is asked, not skimmed')
  for (let n = 0; n < 3; n++) {
    const debtor = 1 + n
    h.eq(h.s.debt != null && h.s.debt.debtor, h.id(debtor), `relay row ${n + 1} is p${debtor}\u2019s`)
    h.eq(h.s.debtQueue.length, 2 - n, `the queue drains behind it (${2 - n} left)`)
    h.eq(h.p(0).cash, 1500 + n * 10, 'the drawer has only collected what was paid')
    h.ok(h.act(debtor, { type: 'payDebt' }), `payer ${n + 1} taps`)
    h.eq(h.p(debtor).cash, 1490, 'and only now loses the $10')
    h.eq(h.p(0).cash, 1510 + n * 10, 'the drawer collects inline')
  }
  h.eq(h.s.debt, null, 'the relay drained')
  h.eq(h.s.phase, 'ROLL', 'Asha rolls again on the birthday doubles')
})

scenario('chairman relay: one debtor, three creditors — fresh clock per row', 4, (h) => {
  h.s.chanceDeck = ['ch15'] // Elected Chairman of the Board. Pay each player $50.
  h.now(0)
  h.p(0).pos = 34
  h.roll(0, [[1, 1]]) // → 36 Chance
  h.ok(h.act(0, { type: 'drawCard' }), 'spin the wheel')
  h.eq(h.s.debt != null && h.s.debt.debtor, h.id(0), 'the chairman owes the first row')
  h.eq(h.s.debtQueue.length, 2, 'two more rows queued behind it')
  const keys: string[] = []
  for (let n = 0; n < 3; n++) {
    const d = decisionFor(h.s, 0) // host clock OFF — an affordable debt arms anyway
    h.assert(d != null, `relay row ${n + 1} is clocked even with the timer off`)
    h.eq(d != null ? d.ms : -1, 30_000, `affordable relay row ${n + 1} gets the 30s tap clock`)
    h.eq(d != null ? d.playerId : '', h.id(0), 'the clock belongs to the chairman')
    if (d) keys.push(d.key)
    h.eq(h.s.debt != null && h.s.debt.creditor, h.id(1 + n), `row ${n + 1} is addressed to p${1 + n}`)
    h.ok(h.act(0, { type: 'payDebt' }), 'chairman pays this row')
    h.eq(h.p(1 + n).cash, 1550, 'this creditor collected')
  }
  h.eq(new Set(keys).size, keys.length, 'every relay row gets its OWN clock key — no inherited expiry')
  h.eq(h.s.debt, null, 'relay done')
  h.eq(h.p(0).cash, 1350, 'the chairman paid all three by tap')
})

scenario('repairs with nothing owned raises no prompt', 4, (h) => {
  h.s.chanceDeck = ['ch11'] // general repairs — total is $0 with no buildings
  h.now(0)
  h.p(0).pos = 34
  h.roll(0, [[1, 1]]) // → 36 Chance
  h.ok(h.act(0, { type: 'drawCard' }), 'spin')
  h.eq(h.s.debt, null, 'a $0 bill never becomes a debt (charge guards amount>0)')
  h.eq(h.s.debtQueue.length, 0, 'nothing queued either')
  h.eq(h.p(0).cash, 1500, 'wallet untouched')
  h.eq(h.s.phase === 'DEBT', false, 'and the table never freezes on $0')
})

scenario('affordable 3-fail jail fine: prompt, then the stroll completes', 4, (h) => {
  h.p(0).jail = true
  h.p(0).jailRolls = 2
  h.p(0).pos = 10
  h.now(0)
  h.roll(0, [[3, 4]]) // third failure, sum 7 — the $50 is sitting in the wallet
  h.eq(h.s.phase, 'DEBT', 'even the solvent fine waits for a tap')
  h.eq(h.s.debt != null && h.s.debt.amount, 50, 'the $50 fine')
  h.eq(h.s.debt != null && h.s.debt.memo, 'Jail release fine', 'the memo names the reason')
  h.eq(h.s.pendingMove, 7, 'the stroll is parked until it settles')
  h.eq(h.p(0).cash, 1500, 'cash untouched pre-tap')
  h.ok(h.act(0, { type: 'payDebt' }), 'pay the fine')
  h.eq(h.p(0).cash, 1450, 'the fine left on the tap')
  h.eq(h.p(0).pos, 17, 'the walk completes: 10 + 7')
  h.eq(h.s.pendingMove, null, 'the parked move is spent')
  h.eq(h.s.debt, null, 'debt cleared')
  h.eq(h.s.phase, 'ACTION', 'the stroll landed on a chest — the turn continues live')
})

scenario('debtBlurb reads every memo shape', 4, (h) => {
  h.eq(debtBlurb({ memo: 'Rent: Boardwalk' }), 'rent for Boardwalk', 'rent names the street')
  h.eq(debtBlurb({ memo: 'Luxury tax' }), 'Luxury Tax', 'luxury is title-cased')
  h.eq(debtBlurb({ memo: 'Income tax' }), 'Income Tax', 'income tax is title-cased')
  h.eq(debtBlurb({ memo: 'Jail release fine' }), 'jail fine', 'the jail fine is terse')
  h.eq(debtBlurb({ memo: "Card: It's your birthday. Collect $10 from every player." }), "It's your birthday", 'the collect tail is dropped')
  h.eq(debtBlurb({ memo: 'Card: Hospital fees. Pay $100.' }), 'Hospital fees', 'the pay tail is dropped')
  h.eq(debtBlurb({ memo: 'Card: Collect $200.' }), 'a card fee', 'all-instruction text falls back')
  h.eq(debtBlurb({ memo: 'Card: Speeding fine. Pay $15.' }), 'Speeding fine', 'mid-word pay is not matched')
  h.eq(debtBlurb({ memo: 'House rules note.' }), 'House rules note.', 'a plain memo passes through as-is')
  h.eq(debtBlurb({}), 'a debt', 'no memo, no blurb')
  h.eq(debtBlurb(null), 'a debt', 'a missing debt still speaks')
})

scenario('forfeit mid-relay redirects the queued collections to the bank', 4, (h) => {
  // birthday relay INTO Ben; Ben walks out mid-freeze. Neither the active
  // row nor any queued row may ever land on a dead seat.
  const memo = "Card: It's your birthday. Collect $10 from every player."
  h.s.debt = { debtor: h.id(0), amount: 10, creditor: h.id(1), memo }
  h.s.debtQueue = [
    { debtor: h.id(2), amount: 10, creditor: h.id(1), memo },
    { debtor: h.id(3), amount: 10, creditor: h.id(1), memo },
  ]
  h.s.phase = 'DEBT'
  h.give(1, [6]) // Ben owns a deed, so the forfeit has an estate
  h.cash(1, 200)
  h.ok(forfeitSeat(h.s, h.id(1), 'Ben left the party'), 'the creditor forfeits mid-relay')
  h.eq(h.s.debt != null && h.s.debt.creditor, null, 'the active row now pays the bank')
  h.eq(h.s.debtQueue.every((d) => d.creditor === null), true, 'every queued row re-points to the bank')
  h.ok(h.act(0, { type: 'payDebt' }), 'Asha pays')
  h.eq(h.p(0).cash, 1490, 'the $10 left her wallet')
  h.eq(h.p(1).cash, 0, 'no cash landed on the dead seat')
  h.eq(h.s.debt != null && h.s.debt.debtor, h.id(2), 'the queued debt activated behind it')
  h.ok(h.act(2, { type: 'payDebt' }), 'Cho pays the bank too')
  h.eq(h.s.debt != null && h.s.debt.debtor, h.id(3), 'and the last row is live')
  h.ok(h.act(3, { type: 'payDebt' }), 'Dara pays')
  h.eq(h.s.debt, null, 'the relay drained — nothing pays a corpse')
  h.eq(h.s.phase, 'AUCTION', "Ben\u2019s forfeited deed goes under the hammer next")
})

scenario('exit with an unpaid bank prompt kills the debt and wakes the queue', 4, (h) => {
  // Asha is frozen on a bank debt with more rows queued — one of hers, one
  // of Cho's. Walking out kills her rows, wakes the stranger's.
  h.s.debt = { debtor: h.id(0), amount: 75, creditor: null, memo: 'Luxury tax' }
  h.s.debtQueue = [
    { debtor: h.id(0), amount: 10, creditor: h.id(1), memo: "Card: It's your birthday. Collect $10 from every player." },
    { debtor: h.id(2), amount: 10, creditor: h.id(1), memo: "Card: It's your birthday. Collect $10 from every player." },
  ]
  h.s.phase = 'DEBT'
  h.now(0)
  h.ok(forfeitSeat(h.s, h.id(0), 'Asha left the party'), 'she walks out mid-prompt')
  h.eq(h.s.debt != null && h.s.debt.debtor, h.id(2), 'the next queued debt activates')
  h.eq(h.s.debt != null && h.s.debt.creditor, h.id(1), "the stranger's row keeps its creditor")
  h.eq(h.s.debtQueue.length, 0, "her own queued row died with the seat")
  h.eq(h.p(0).cash, 0, 'no payment ever left the wallet — the debt died with it')
  h.eq(h.s.phase, 'DEBT', 'the relay continues without her')
  h.eq(h.p(1).cash, 1500, 'the creditor still waits for Cho')
  h.ok(h.act(2, { type: 'payDebt' }), 'Cho settles the woken row')
  h.eq(h.p(1).cash, 1510, 'Ben finally collects the one live row')
})

scenario('the game log is capped so a god export always re-imports', 4, (h) => {
  // A long 6-player game writes well over the import validator's limit,
  // which made ordinary games impossible to export and import back. The
  // engine now trims as it writes, oldest lines first.
  h.s.log.push(...Array.from({ length: MAX_GAME_LOG + 5 }, (_, k) => ({ text: `filler ${k}`, kind: 'info' as const })))
  h.roll(0, [[2, 3]]) // sum 5 → lands on the unowned first railroad — writes a line
  h.eq(h.s.log.length, MAX_GAME_LOG, 'the log never grows past the cap')
  h.eq(h.s.log[h.s.log.length - 1].text.includes('landed on unowned'), true, 'the newest line survived the trim')
  h.eq(h.s.log[0].text.startsWith('filler'), true, 'the oldest lines were the ones dropped')
})

// ── autoSettle: the debt-clock liquidation (rooms + engine) ──

scenario('autoSettle sells the dearest house, mortgages the cheap single, then the next house', 4, (h) => {
  // A $180 bank debt against $10 cash: the two phases alternate, each step
  // re-checked against the wallet, stopping the moment the bill is covered.
  // Dearest-first selling keeps the buildings destroyed to a minimum; the
  // cheap single mortgaged before the monopoly (keeps double-rent alive).
  h.cash(0, 10)
  h.give(0, [37, 39, 3]) // blue monopoly with houses + single Baltic
  h.prop(37, { houses: 2 })
  h.prop(39, { houses: 2 })
  h.s.debt = { debtor: h.id(0), amount: 180, creditor: null }
  h.s.phase = 'DEBT'
  const built = debtAutoActions(h.s, h.id(0))
  h.eq(built.autos.length, 4, 'the settle is the plan plus the payment')
  h.eq(built.autos[built.autos.length - 1], [h.id(0), { type: 'payDebt' }], 'it ends in payDebt')
  h.eq(
    built.headline != null && built.headline.includes('the bank liquidates Asha') && built.headline.includes('$180'),
    true,
    'the liquidation headline rides the same commit',
  )
  const plan = liquidationPlan(h.s, h.id(0), 180)
  const step = (a: Action): string => (a.type === 'sellHouse' || a.type === 'mortgage' ? `${a.type}:${a.space}` : a.type)
  h.eq(
    plan.map(([, a]) => step(a)),
    ['sellHouse:37', 'mortgage:3', 'sellHouse:39'],
    'exact order: dearest house (tie → lower index), cheap single, next house',
  )
  // replaying the plan through the real reducer reproduces it step for step
  for (const [, a] of plan) h.ok(h.act(0, a), 'each planned step is legal against its predecessors')
  h.eq(h.p(0).cash, 240, '10 + 100 + 30 + 100 raised')
  h.ok(h.act(0, { type: 'payDebt' }), 'the settle pays on the same list')
  h.eq(h.p(0).cash, 60, 'the debt left the wallet')
  h.eq(h.s.props[3].mortgaged, true, 'the single is mortgaged')
  h.eq(h.s.props[37].mortgaged, false, 'the monopoly is untouched by mortgages')
  h.eq(h.s.props[37].houses, 1, 'even selling preserved: one house left on Park Place')
  h.eq(h.s.props[39].houses, 1, 'and one on Boardwalk')
  h.eq(h.s.debt, null, 'debt settled')
})

scenario('autoSettle pays with mortgages alone when no houses stand', 4, (h) => {
  h.cash(0, 10)
  h.give(0, [1, 11]) // singles in two different groups, no houses anywhere
  h.s.debt = { debtor: h.id(0), amount: 60, creditor: null }
  h.s.phase = 'DEBT'
  const built = debtAutoActions(h.s, h.id(0))
  const plan = liquidationPlan(h.s, h.id(0), 60)
  const step = (a: Action): string => (a.type === 'sellHouse' || a.type === 'mortgage' ? `${a.type}:${a.space}` : a.type)
  h.eq(plan.map(([, a]) => step(a)), ['mortgage:1', 'mortgage:11'], 'cheapest unmonopolized single first, then the next')
  h.eq(built.autos.length, plan.length + 1, 'autos are exactly the plan plus payDebt')
  for (const [, a] of plan) h.ok(h.act(0, a), 'each step replays clean')
  h.eq(h.p(0).cash, 10 + 30 + 75, 'mortgage proceeds raised the funds')
  h.ok(h.act(0, { type: 'payDebt' }), 'and the payment settles it')
  h.eq(h.p(0).cash, 55, 'settled: 10 + 30 + 75 − 60')
  h.eq(h.s.props[1].mortgaged && h.s.props[11].mortgaged, true, 'both singles mortgaged')
})

scenario('autoSettle falls to true bankruptcy when the estate cannot cover it', 4, (h) => {
  // A $500 player-debt against a $40 estate: even full liquidation cannot
  // cover the bill, so the existing bankruptcy cascade fires — with NO
  // pre-bankruptcy liquidation committed. Creditor estate transfer first
  // (the assertions the existing bankruptcy scenario pins), then the
  // bank variant: deeds under the hammer.
  h.give(0, [3])
  h.cash(0, 10)
  h.cash(1, 100)
  h.s.debt = { debtor: h.id(0), amount: 500, creditor: h.id(1) }
  h.s.phase = 'DEBT'
  const built = debtAutoActions(h.s, h.id(0))
  h.eq(built.autos, [[h.id(0), { type: 'bankrupt' }]], 'bankruptcy is the play when liquidation cannot cover')
  h.eq(
    built.headline != null && built.headline.includes("Asha can't cover the $500"),
    true,
    'the bankruptcy-despite-liquidation headline',
  )
  h.eq(h.s.props[3].mortgaged, false, 'no liquidation was committed ahead of the bankruptcy')
  h.ok(h.act(0, { type: 'bankrupt' }), 'the existing cascade, untouched')
  h.eq(h.p(0).bankrupt, true, 'bankrupt')
  h.eq(h.p(1).cash, 110, 'the creditor got the estate ($10 cash + the deed, unmortgaged → no interest)')
  h.eq(h.s.props[3].owner, h.id(1), 'the deed transferred')
  h.eq(h.s.props[3].mortgaged, false, 'unmortgaged — no interest due')
  h.eq(h.s.phase, 'ROLL', 'play continues')

  // bank variant: the hammer, exactly like the existing bank-bankruptcy scenario
  h.give(2, [6, 11])
  h.cash(2, 10)
  h.s.debt = { debtor: h.id(2), amount: 999, creditor: null }
  h.s.phase = 'DEBT'
  const built2 = debtAutoActions(h.s, h.id(2))
  h.eq(built2.autos, [[h.id(2), { type: 'bankrupt' }]], 'bank debts go bankrupt the same way')
  h.ok(h.act(2, { type: 'bankrupt' }), 'bankrupt to the bank')
  h.eq(h.s.props[6].owner, null, 'property back with the bank')
  h.eq(h.s.auction != null && (h.s.auction.space === 6 || h.s.auction.space === 11), true, 'one deed under the hammer')
  h.eq(
    h.s.auctionQueue.includes(h.s.auction != null && h.s.auction.space === 6 ? 11 : 6),
    true,
    'the second deed queued behind it',
  )
  h.eq(h.s.phase, 'AUCTION', 'liquidation auction running')
})

scenario('autoSettle never strips monopolies while singles remain', 4, (h) => {
  h.cash(0, 0)
  h.give(0, [31, 32, 34]) // the full green monopoly
  h.give(0, [6, 5]) // a single street and a railroad
  h.s.debt = { debtor: h.id(0), amount: 100, creditor: null }
  h.s.phase = 'DEBT'
  const plan = liquidationPlan(h.s, h.id(0), 100)
  const step = (a: Action): string => (a.type === 'sellHouse' || a.type === 'mortgage' ? `${a.type}:${a.space}` : a.type)
  h.eq(plan.map(([, a]) => step(a)), ['mortgage:6', 'mortgage:5'], 'singles first — cheapest printed price first')
  h.eq(h.s.props[31].mortgaged, false, 'the monopoly is intact (the plan is pure — nothing applied to the real state)')
  // a deeper bill: only when the singles are gone do the monopoly streets
  // go, cheapest first
  const deep = liquidationPlan(h.s, h.id(0), 400)
  h.eq(
    deep.map(([, a]) => step(a)),
    ['mortgage:6', 'mortgage:5', 'mortgage:31', 'mortgage:32'],
    'monopolized groups go last, cheapest street first',
  )
})

scenario('an unaffordable debt arms the 90s autoSettle clock at timer-off', 4, (h) => {
  h.cash(0, 10)
  h.give(0, [3])
  h.s.debt = { debtor: h.id(0), amount: 500, creditor: null }
  h.s.phase = 'DEBT'
  const d = decisionFor(h.s, 0)
  h.assert(d != null, 'the raise-funds window is armed even at timer-off')
  h.eq(d != null ? d.ms : -1, 90_000, '90 seconds to raise funds before the bank auto-settles')
  h.eq(d != null ? d.playerId : '', h.id(0), 'the clock belongs to the debtor alone — nobody else is clocked in the freeze')
})

scenario('autoSettle on a chairman relay pays only the ACTIVE row', 4, (h) => {
  const memo = 'Card: Elected Chairman of the Board. Pay each player $50.'
  h.cash(0, 10)
  h.give(0, [3, 6])
  h.s.debt = { debtor: h.id(0), amount: 50, creditor: h.id(1), memo }
  h.s.debtQueue = [
    { debtor: h.id(0), amount: 50, creditor: h.id(2), memo },
    { debtor: h.id(0), amount: 50, creditor: h.id(3), memo },
  ]
  h.s.phase = 'DEBT'
  const key1 = decisionFor(h.s, 0)?.key ?? ''
  const built = debtAutoActions(h.s, h.id(0))
  h.eq(built.autos[built.autos.length - 1], [h.id(0), { type: 'payDebt' }], 'the settle ends in payDebt')
  for (const [, a] of built.autos) h.ok(h.act(0, a), 'the whole list runs clean on one commit')
  h.eq(h.p(1).cash, 1550, 'row 1 collected')
  h.eq(h.p(2).cash, 1500, 'row 2 has not been touched')
  h.eq(h.s.debt != null && h.s.debt.creditor, h.id(2), 'row 2 is the active debt now')
  h.eq(h.s.debtQueue.length, 1, 'row 3 still queued behind it')
  const key2 = decisionFor(h.s, 0)?.key ?? ''
  h.assert(key2 !== key1, 'row 2 re-arms with a fresh clock key — no inherited expiry')
})

scenario('one idle phone cannot stall a timer-off table: per-key defaults', 4, (h) => {
  const ms = (key: string): number | null => {
    const d = decisionFor(h.s, 0)
    if (d == null) return null
    h.assert(d.key.startsWith(`${key}:`), `the clocked decision is ${key}`)
    return d.ms
  }
  h.eq(ms('roll'), 60_000, 'roll defaults to 60s at timer-off (expiry auto-rolls)')
  h.s.phase = 'ACTION'
  h.s.pendingCardDraw = { player: h.id(0), deck: 'chest', space: 17 }
  h.eq(ms('draw'), 30_000, 'a pending draw defaults to 30s')
  h.s.pendingCardDraw = null
  h.s.pendingPurchase = 6
  h.eq(ms('buy'), 60_000, 'a pending buy defaults to 60s (expiry declines → auction)')
  h.s.pendingPurchase = null
  h.s.pendingTax = { player: h.id(0), space: 4 }
  h.eq(ms('tax'), 60_000, 'a pending tax defaults to 60s (expiry pays the cheaper option)')
  h.s.pendingTax = null
  h.s.pendingJail = { player: h.id(0), reason: 'card' }
  h.eq(ms('jail'), 30_000, 'an arrest keeps its fixed 30s')
  h.s.pendingJail = null
  h.eq(ms('end'), 30_000, 'end-of-turn keeps its fixed 30s')
  h.s.debt = { debtor: h.id(0), amount: 50, creditor: null }
  h.s.phase = 'DEBT'
  h.eq(ms('debt'), 30_000, 'an affordable debt keeps its fixed 30s tap clock')
  h.cash(0, 10)
  h.eq(ms('debt'), 90_000, 'an unaffordable debt gets the 90s raise-funds window')
  h.s.debt = null
  h.s.phase = 'AUCTION'
  h.s.auction = { space: 6, bid: 0, bidder: null, passed: [] }
  h.eq(ms('auc'), 30_000, 'auction opening window (30s)')
  h.s.auction = { space: 6, bid: 40, bidder: h.id(1), passed: [] }
  h.eq(ms('auc'), 15_000, 'auction after-a-bid fuse (15s)')
})

// ── the one commit path + the socket pre-gate (rooms) ──

scenario('commit: every path commits only on success and rejects cleanly', 4, (h) => {
  // a legal action commits
  {
    const room = stubRoom(h.s)
    const res = commit(room, null, h.id(0), { type: 'roll' })
    h.ok(res, 'a legal action commits')
    h.eq(room.state != null && room.state.dice != null, true, 'the roll landed in the committed state')
  }
  // an illegal one rejects cleanly and mutates nothing
  {
    const room = stubRoom(h.s)
    const before = JSON.stringify(room.state)
    const res = commit(room, null, h.id(1), { type: 'roll' })
    h.bad(res, "another player's roll is refused")
    h.eq(JSON.stringify(room.state), before, 'a rejected action mutates nothing')
  }
  // a god-style mutate commits (the tamper-proof console is ungated)
  {
    const room = stubRoom(h.s)
    const res = commit(room, null, '', (n) => {
      n.players[1].cash += 7
    })
    h.ok(res, 'a god mutate commits')
    h.eq(room.state != null && room.state.players[1].cash, 1507, 'the mutation landed')
  }
  // a forfeit commits on success — and refuses cleanly the second time
  h.give(1, [6])
  {
    const room = stubRoom(h.s)
    const res = commit(room, null, h.id(1), (n) => forfeitSeat(n, h.id(1), 'Ben left the party'))
    h.ok(res, 'a forfeit commits')
    h.eq(room.state != null && room.state.players[1].bankrupt, true, 'the seat is bankrupt in the committed state')
    const before = JSON.stringify(room.state)
    const again = commit(room, null, h.id(1), (n) => forfeitSeat(n, h.id(1), 'again'))
    h.bad(again, 'forfeiting an already-bankrupt seat refuses cleanly')
    h.eq(JSON.stringify(room.state), before, 'nothing changed the second time')
  }
})

scenario('the pre-gate: a gated-out action mutates nothing and acks the standard error', 4, (h) => {
  const room = stubRoom(h.s)
  const before = JSON.stringify(room.state)
  const gated = commit(room, null, h.id(1), { type: 'roll' }, { gate: true })
  h.bad(gated, "the gate refuses a non-current player's roll before any clone")
  h.eq(gated.ok === false ? gated.error : 'ok', "You can't do that right now (roll)", 'the standard error ack, byte-identical to the reducer\u2019s')
  h.eq(JSON.stringify(room.state), before, 'an illegal socket action never costs a state copy')
  // what the engine allows passes the gate and commits
  const allowed = commit(room, null, h.id(0), { type: 'roll' }, { gate: true })
  h.ok(allowed, 'a legal action passes the gate through to the reducer')
  h.eq(room.state != null && room.state.dice != null, true, 'and commits')
})

// ── rng threading: SEED-replay determinism (engine) ──

scenario('rng determinism: same seed, identical game — deck rebuilds included', 4, (h) => {
  // Drive a scripted game with a seeded rng, twice, forcing deck rebuilds
  // (empty deck → rebuildDeck) and a bankruptcy (→ resumeAfterDebt).
  // Before the rng threading, the rebuild reshuffled with Math.random and
  // the two runs diverged.
  const run = (): string => {
    const rng = mulberry32(20261126)
    const metas: PlayerMeta[] = Array.from({ length: 4 }, (_, i) => ({
      id: `q${i}`,
      name: NAMES[i],
      color: '#000000',
      token: TOKENS[i],
    }))
    const s = createGame(metas, rng)
    const draw = (pid: string): void => {
      s.phase = 'ACTION'
      s.currentPlayerId = pid
      s.pendingCardDraw = { player: pid, deck: 'chance', space: 7 }
      applyAction(s, { type: 'drawCard' }, pid, rng)
    }
    s.chanceDeck = [] // force a rebuild on the very first draw
    draw('q0') // rebuildDeck fires with the threaded rng
    s.chanceDeck = []
    draw('q1') // and again
    s.pendingCardDraw = null
    s.phase = 'ROLL'
    s.currentPlayerId = 'q2'
    applyAction(s, { type: 'roll' }, 'q2', rng)
    // a bankruptcy exercises resumeAfterDebt with the threaded rng
    s.debt = { debtor: 'q3', amount: 10_000, creditor: 'q1' }
    s.phase = 'DEBT'
    applyAction(s, { type: 'bankrupt' }, 'q3', rng)
    return JSON.stringify(s)
  }
  const a = run()
  const b = run()
  h.eq(a === b, true, 'same seed → byte-identical end state, reshuffles in play')
  h.assert(a.length > 500, 'the scripted run produced real state')
})

// ── auction grace predicate parity (rooms) ──

scenario('auctionGraceActions passes exactly the seats the old inline check did', 4, (h) => {
  h.s.phase = 'AUCTION'
  h.s.auction = { space: 6, bid: 40, bidder: h.id(1), passed: [h.id(2)] }
  h.p(3).bankrupt = true
  const seat = (i: number, socketId: string | null, goneFor: number) => ({
    meta: { id: h.id(i), name: NAMES[i], color: '#000000', token: TOKENS[i] },
    token: `t${i}`,
    socketId,
    disconnectedAt: socketId == null ? Date.now() - goneFor : null,
  })
  const room = stubRoom(h.s)
  room.players = [
    seat(0, null, 20_000), // gone 20s → due
    seat(1, 'sock-1', 0), // connected + high bidder → not due
    seat(2, null, 20_000), // gone, but already passed → not due
    seat(3, null, 20_000), // gone, but bankrupt → not due
  ]
  h.eq(auctionGraceActions(room), [[h.id(0), { type: 'passBid' }]], 'exactly one seat due, same as the piggybacked check')
  room.players[0].disconnectedAt = Date.now() - 5_000
  h.eq(auctionGraceActions(room), [], 'a seat still inside the grace window is left to the fuse')
})

// ── waitingOn: the blocking-decision projection ──
// Who the game is waiting on and what kind of decision blocks, projected
// into every view by the shared blockingDecision() helper. Timer-off is
// the headline: the projection reads no clock, so it must be identical
// with the decision timer disabled and enabled.
scenario('waitingOn names who and what blocks, with or without a clock', 4, (h) => {
  // ROLL pending → the current player's roll attempt
  h.s.phase = 'ROLL'
  h.eq(blockingDecision(h.s), { key: `roll:1:${h.id(0)}:0:0`, playerId: h.id(0), kind: 'roll' }, 'a fresh turn waits on the current player rolling')
  // a jailed player in ROLL still owes the roll attempt (pay fine / card
  // are alternatives on the SAME decision — the two-step arrest is the
  // separate 'jail' kind below)
  h.p(0).jail = true
  h.eq(blockingDecision(h.s)?.kind, 'roll', 'a jailed player in ROLL still waits on the roll attempt')
  h.p(0).jail = false

  // the announced arrest → 'jail', owned by the arrested player
  h.s.phase = 'ACTION'
  h.s.pendingJail = { player: h.id(2), reason: 'doubles' }
  h.eq(blockingDecision(h.s), { key: `jail:1:${h.id(2)}`, playerId: h.id(2), kind: 'jail' }, 'the announced arrest waits on the arrested player')

  // pending card draw → 'draw'
  h.s.pendingJail = null
  h.s.pendingCardDraw = { player: h.id(0), deck: 'chance', space: 8 }
  h.eq(blockingDecision(h.s), { key: `draw:1:chance:8`, playerId: h.id(0), kind: 'draw' }, 'a landed card space waits on the drawer')

  // pending purchase → 'buy'
  h.s.pendingCardDraw = null
  h.s.pendingPurchase = 6
  h.eq(blockingDecision(h.s), { key: `buy:1:6`, playerId: h.id(0), kind: 'buy' }, 'an unowned landing waits on buy or decline')

  // pending tax → 'tax'
  h.s.pendingPurchase = null
  h.s.pendingTax = { player: h.id(0), space: 4 }
  h.eq(blockingDecision(h.s), { key: `tax:1`, playerId: h.id(0), kind: 'tax' }, 'income tax waits on the choice')

  // plain ACTION → 'end'
  h.s.pendingTax = null
  h.eq(blockingDecision(h.s), { key: `end:1:${h.id(0)}`, playerId: h.id(0), kind: 'end' }, 'an idled turn waits on End turn')

  // DEBT → 'debt', owned by the debtor (bank creditor spelled out)
  h.s.phase = 'DEBT'
  h.s.debt = { debtor: h.id(1), amount: 50, creditor: null }
  h.eq(blockingDecision(h.s), { key: `debt:1:${h.id(1)}:bank:50:0`, playerId: h.id(1), kind: 'debt' }, 'a debt freeze waits on the debtor')

  // AUCTION → 'auc' with playerId null — the whole table is the owner,
  // which is exactly why deadlineFor's null overload can't serve this
  h.s.phase = 'AUCTION'
  h.s.debt = null
  h.s.auction = { space: 6, bid: 0, bidder: null, passed: [] }
  h.eq(blockingDecision(h.s), { key: `auc:1:6:0:-`, playerId: null, kind: 'auc' }, 'an auction waits on everyone (playerId null)')

  // finished games block on nothing
  h.s.phase = 'GAME_OVER'
  h.s.auction = null
  h.eq(blockingDecision(h.s), null, 'GAME_OVER blocks on nothing')

  // the view projection is DERIVED (never stored) and reads no clock: the
  // field is byte-identical at timer-off and timer-on, and equals the
  // shared helper the server's own decision clock delegates to
  h.s.phase = 'ROLL'
  h.eq(
    hostView(h.s, 'TEST', null, 0).waitingOn,
    hostView(h.s, 'TEST', null, 300_000).waitingOn,
    'waitingOn ignores the clock setting',
  )
  h.eq(hostView(h.s, 'TEST', null, 0).waitingOn, blockingDecision(h.s), 'the view field is the shared projection')
  h.assert(!('waitingOn' in h.s), 'waitingOn is never stored in GameState')
})

// ── cardEffectLine: the Chance/Chest result-line contract ──
// The copy strings ARE the contract (phone + TV render them verbatim);
// these assertions are byte-exact on purpose.

scenario('cardEffectLine: money and pay cards name the bank amount', 4, (h) => {
  h.eq(cardEffectLine(cardById('ch7'), h.s, h.id(0)), '+$50 from the bank', 'ch7 dividend')
  h.eq(cardEffectLine(cardById('ch16'), h.s, h.id(0)), '+$150 from the bank', 'ch16 building loan')
  h.eq(cardEffectLine(cardById('cc2'), h.s, h.id(0)), '+$200 from the bank', 'cc2 bank error')
  h.eq(cardEffectLine(cardById('cc14'), h.s, h.id(0)), '+$25 from the bank', 'cc14 consultancy fee')
  h.eq(cardEffectLine(cardById('ch12'), h.s, h.id(0)), '-$15 to the bank', 'ch12 speeding fine')
  h.eq(cardEffectLine(cardById('cc3'), h.s, h.id(0)), '-$50 to the bank', 'cc3 doctor fee')
  h.eq(cardEffectLine(cardById('cc12'), h.s, h.id(0)), '-$100 to the bank', 'cc12 hospital fees')
})

scenario('cardEffectLine: payEach and collectEach count the other living players', 4, (h) => {
  h.eq(cardEffectLine(cardById('ch15'), h.s, h.id(0)), '-$50 x 3 players = -$150', 'chairman pays each of the 3 others')
  h.eq(cardEffectLine(cardById('cc7'), h.s, h.id(0)), '+$50 x 3 players = +$150', 'opera night collects from 3')
  h.eq(cardEffectLine(cardById('cc10'), h.s, h.id(0)), '+$10 x 3 players = +$30', 'birthday collects from 3')
  // a bankrupt seat is not part of the table any more
  h.p(3).bankrupt = true
  h.eq(cardEffectLine(cardById('ch15'), h.s, h.id(0)), '-$50 x 2 players = -$100', 'bankrupt seats are not charged')
  h.eq(cardEffectLine(cardById('cc7'), h.s, h.id(0)), '+$50 x 2 players = +$100', 'and do not pay into collections')
})

scenario('cardEffectLine: payEach and collectEach with one opponent read singular', 2, (h) => {
  h.eq(cardEffectLine(cardById('ch15'), h.s, h.id(0)), '-$50 x 1 player = -$50', 'one opponent, singular')
  h.eq(cardEffectLine(cardById('cc10'), h.s, h.id(0)), '+$10 x 1 player = +$10', 'one opponent, singular')
})

scenario('cardEffectLine: repairs bills compute the drawer real holdings', 4, (h) => {
  // ch11: $25/house, $100/hotel. The drawer holds Mediterranean (2 houses),
  // Baltic (a hotel) and one railroad (ignored — repairs count buildings only).
  h.give(0, [1, 3, 5])
  h.prop(1, { houses: 2 })
  h.prop(3, { houses: 5 })
  h.eq(cardEffectLine(cardById('ch11'), h.s, h.id(0)), 'Bill: $150 ($25 per house, $100 per hotel)', '2 houses + 1 hotel, the rail ignored')
  // cc15 ($40/house, $115/hotel) on the same estate
  h.eq(cardEffectLine(cardById('cc15'), h.s, h.id(0)), 'Bill: $195 ($40 per house, $115 per hotel)', 'the same estate on the chest card')
  // a drawer with no buildings owes nothing
  h.give(1, [6])
  h.eq(cardEffectLine(cardById('ch11'), h.s, h.id(1)), 'Bill: $0 ($25 per house, $100 per hotel)', 'an empty estate owes $0')
})

scenario('cardEffectLine: goto copies are static, ch13 never doubles', 4, (h) => {
  h.eq(cardEffectLine(cardById('ch1'), h.s, h.id(0)), '-> GO - collect $200', 'advance to GO (chance)')
  h.eq(cardEffectLine(cardById('cc1'), h.s, h.id(0)), '-> GO - collect $200', 'advance to GO (chest)')
  h.eq(cardEffectLine(cardById('ch2'), h.s, h.id(0)), '-> Illinois Ave - collect $200 if you pass GO', 'advance to Illinois')
  h.eq(cardEffectLine(cardById('ch3'), h.s, h.id(0)), '-> St. Charles Place - collect $200 if you pass GO', 'the card text omits the GO clause; the copy carries it')
  h.eq(cardEffectLine(cardById('ch13'), h.s, h.id(0)), '-> JR East - Yamanote Line - collect $200 if you pass GO', 'the railroad TRIP charges normal rent: no doubling copy')
  h.eq(cardEffectLine(cardById('ch14'), h.s, h.id(0)), '-> Boardwalk - collect $200 if you pass GO', 'walk on the Boardwalk')
})

scenario('cardEffectLine: move, nearest, jailcard, gotojail', 4, (h) => {
  h.eq(cardEffectLine(cardById('ch9'), h.s, h.id(0)), '-> 3 spaces back', 'go back 3')
  h.eq(cardEffectLine(cardById('ch4'), h.s, h.id(0)), '-> nearest railroad - pay double rent if owned', 'nearest rail: the doubling is real and now stated')
  h.eq(cardEffectLine(cardById('ch5'), h.s, h.id(0)), '-> nearest railroad - pay double rent if owned', 'the second nearest-rail card says the same')
  h.eq(cardEffectLine(cardById('ch6'), h.s, h.id(0)), '-> nearest utility - 10x a fresh dice roll if owned', 'nearest utility reads 10x, never "if both owned"')
  h.eq(cardEffectLine(cardById('ch10'), h.s, h.id(0)), '-> straight to Jail - no $200 for passing GO', 'go directly to jail (chance)')
  h.eq(cardEffectLine(cardById('cc6'), h.s, h.id(0)), '-> straight to Jail - no $200 for passing GO', 'go directly to jail (chest)')
  h.eq(cardEffectLine(cardById('ch8'), h.s, h.id(0)), undefined, 'a jail card carries no effect line')
  h.eq(cardEffectLine(cardById('cc5'), h.s, h.id(0)), undefined, 'the chest jail card neither')
})

scenario('cardEffectLine: every card in both decks is enumerated', 4, (h) => {
  for (const c of ALL_CARDS) {
    const line = cardEffectLine(c, h.s, h.id(0))
    if (c.effect.kind === 'jailcard') h.eq(line, undefined, `${c.id} (jail card) has no effect line`)
    else h.assert(typeof line === 'string' && line.length > 0, `${c.id} produced an effect line`)
  }
})

// ── debtWhy: the recomputed why on the debt chip ──

scenario('debtWhy: houses tier, full set and rail count, recomputed from state', 4, (h) => {
  // 3 houses on Boardwalk (rent $600 at that tier)
  h.give(1, [39])
  h.prop(39, { houses: 3 })
  h.eq(debtWhy(h.s, { debtor: h.id(0), amount: 600, creditor: h.id(1), memo: 'Rent: Boardwalk' }), '3 houses', 'the houses tier is the why')
  // a hotel ($2000)
  h.prop(39, { houses: 5 })
  h.eq(debtWhy(h.s, { debtor: h.id(0), amount: 2000, creditor: h.id(1), memo: 'Rent: Boardwalk' }), 'hotel', 'hotel reads as hotel')
  // the full blue set doubles base rent ($50 -> $100)
  h.give(1, [37])
  h.prop(39, { houses: 0 })
  h.eq(debtWhy(h.s, { debtor: h.id(0), amount: 100, creditor: h.id(1), memo: 'Rent: Boardwalk' }), 'full set', 'full-set doubling')
  // a lone deed charges base rent ($50)
  h.prop(37, { owner: null })
  h.eq(debtWhy(h.s, { debtor: h.id(0), amount: 50, creditor: h.id(1), memo: 'Rent: Boardwalk' }), 'base rent', 'a lone deed charges base rent')
  // railroads: the count is the why (3 owned -> $100)
  h.give(1, [5, 15, 35])
  h.eq(debtWhy(h.s, { debtor: h.id(0), amount: 100, creditor: h.id(1), memo: 'Rent: Namma Metro' }), '3 railroads owned', 'the railroad count is the why')
})

scenario('debtWhy: the utility dice product, 4x and the Chance 10x', 4, (h) => {
  h.give(1, [12]) // BESCOM only
  h.s.dice = [3, 6]
  h.eq(debtWhy(h.s, { debtor: h.id(0), amount: 36, creditor: h.id(1), memo: 'Rent: BESCOM' }), '4x your 9 = $36', 'one utility: 4x the dice')
  // the Chance nearest-utility charge reads 10x even with one owned —
  // utilMult bypasses the ownership count, and the amount betrays it
  h.eq(debtWhy(h.s, { debtor: h.id(0), amount: 90, creditor: h.id(1), memo: 'Rent: BESCOM' }), '10x your 9 = $90', 'the nearest-utility charge reads 10x with one owned')
  // both owned: state itself says 10x, and the two agree
  h.give(1, [28])
  h.eq(debtWhy(h.s, { debtor: h.id(0), amount: 90, creditor: h.id(1), memo: 'Rent: BESCOM' }), '10x your 9 = $90', 'both utilities: 10x either way')
})

scenario('debtWhy: card debts keep the debtBlurb text', 4, (h) => {
  h.eq(debtWhy(h.s, { debtor: h.id(0), amount: 100, creditor: null, memo: 'Card: Hospital fees. Pay $100.' }), 'Hospital fees', 'card memos drop the instruction tail')
  h.eq(debtWhy(h.s, { debtor: h.id(0), amount: 50, creditor: null, memo: 'Jail release fine' }), 'jail fine', 'the jail fine keeps its blurb')
  h.eq(debtWhy(h.s, { debtor: h.id(0), amount: 200, creditor: null, memo: 'Luxury tax' }), 'Luxury Tax', 'taxes keep their blurb')
  h.eq(debtWhy(h.s, { debtor: h.id(0), amount: 10, creditor: null }), 'a debt', 'a memo-less debt stays generic')
})

// ── summary ──
if (failures.length > 0) {
  console.log(`\n✗ ${failures.length} failure(s) of ${totalChecks + failures.length} checks:`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
} else {
  console.log(`\n✔ all scenarios passed (${totalChecks} checks)`)
}
