// ── Scenario simulations ──
// Deterministic, white-box tests for every expected rules situation, one file
// next to the random fuzzer (sim.ts). Each scenario shapes a fresh GameState,
// plays rigged dice through the real reducer, and asserts exact outcomes.
// Run: npm run scenarios

import { applyAction, createGame, type PlayerMeta, type Result } from '../shared/engine.js'
import { allowedActions, rentFor } from '../shared/rules.js'
import type { Action, GameState, PlayerState, PropertyState } from '../shared/types.js'

const NAMES = ['Asha', 'Ben', 'Cho', 'Dara']
const TOKENS = ['🎩', '🚗', '🐕', '🚢']

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
      if (a !== b) failures.push(`${name}: ${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`)
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
  h.eq(h.p(1).cash, 1698, 'paid $2 base rent after +200 GO money')
  h.eq(h.p(0).cash, 1502, 'owner collected')
  // doubles → same player rolls again from pos 1
  h.give(0, [3]) // now owns the full brown group
  h.roll(1, [[1, 1]]) // → Baltic: doubled rent $8
  h.eq(h.p(1).cash, 1690, 'color-set doubles the base rent')
  h.eq(h.p(0).cash, 1510, 'owner collected $8')
})

scenario('rent tables: houses, hotels, rails, utilities', 4, (h) => {
  h.give(0, [1, 3])
  h.eq(rentFor(h.s, 1, 7), 4, 'full brown set, no houses → doubled $4')
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
  h.roll(0, [[1, 1]]) // → 5 Reading, unowned
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

scenario('three doubles in a row → straight to jail', 4, (h) => {
  h.roll(0, [[3, 3]]) // → 6, unowned
  h.ok(h.act(0, { type: 'buy' }), 'buy Oriental')
  h.eq(h.s.phase, 'ROLL', 'doubles: roll again')
  h.roll(0, [[3, 3]]) // → 12, unowned
  h.ok(h.act(0, { type: 'declineBuy' }), 'decline Electric Co')
  for (const i of [0, 1, 2, 3]) h.ok(h.act(i, { type: 'passBid' }), `p${i} passes auction`)
  h.eq(h.s.phase, 'ROLL', 'second doubles: roll again')
  h.roll(0, [[3, 3]]) // third doubles
  h.eq(h.p(0).jail, true, 'jailed for speeding')
  h.eq(h.p(0).pos, 10, 'in jail')
  h.eq(h.s.phase, 'ACTION', 'turn ends after the bust')
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

scenario('go to jail space: no GO money', 4, (h) => {
  h.now(0)
  h.p(0).pos = 27
  h.roll(0, [[2, 1]]) // → 30
  h.eq(h.p(0).pos, 10, 'jailed')
  h.eq(h.p(0).jail, true, 'in jail')
  h.eq(h.p(0).cash, 1500, 'no GO money on the way to jail')
})

scenario('chance: nearest railroad charges double rent', 4, (h) => {
  h.give(1, [15])
  h.s.chanceDeck = ['ch4']
  h.now(0)
  h.p(0).pos = 5
  h.roll(0, [[1, 1]]) // → 7 Chance → nearest rail = 15
  h.eq(h.p(0).pos, 15, 'advanced to the railroad')
  h.eq(h.p(0).cash, 1450, 'paid 2× the single-rail rent ($50)')
  h.eq(h.p(1).cash, 1550, 'owner collected')
})

scenario('chance: nearest utility charges 10× a fresh roll', 4, (h) => {
  h.give(1, [28])
  h.s.chanceDeck = ['ch6']
  h.now(0)
  h.p(0).pos = 20
  h.roll(0, [[1, 1], [5, 2]]) // → 22 Chance, then fresh utility roll 5+2
  h.eq(h.p(0).pos, 28, 'advanced to Water Works')
  h.eq(h.p(0).cash, 1430, 'paid 10 × 7 = $70')
})

scenario('chance: advance to Illinois crosses GO and pays $200', 4, (h) => {
  h.s.chanceDeck = ['ch2']
  h.now(0)
  h.p(0).pos = 34
  h.roll(0, [[1, 1]]) // → 36 Chance → Illinois (24)
  h.eq(h.p(0).pos, 24, 'advanced to Illinois Ave')
  h.eq(h.p(0).cash, 1700, 'collected GO money on the wrap')
})

scenario('chance: go back 3 spaces chains into Community Chest', 4, (h) => {
  h.s.chanceDeck = ['ch9']
  h.s.chestDeck = ['cc12'] // hospital fees $100
  h.now(0)
  h.p(0).pos = 34
  h.roll(0, [[1, 1]]) // → 36 Chance → back 3 → 33 Chest → $100
  h.eq(h.p(0).pos, 33, 'back 3 onto Community Chest')
  h.eq(h.p(0).cash, 1400, 'drew and paid the chest card')
  h.eq(h.s.pendingCard != null && h.s.pendingCard.deck, 'chest', 'the chained chest card is showing')
})

scenario('chance: repairs card counts houses and hotels', 4, (h) => {
  h.give(0, [1, 6])
  h.prop(1, { houses: 2 })
  h.prop(6, { houses: 5 }) // hotel
  h.s.chanceDeck = ['ch11']
  h.now(0)
  h.p(0).pos = 34
  h.roll(0, [[1, 1]]) // → 36 Chance: $25/house, $100/hotel
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
  // Birthday card: $10 from every player. Two of them can't pay.
  h.s.chestDeck = ['cc10']
  h.cash(2, 5)
  h.cash(3, 3)
  h.give(2, [11])
  h.give(3, [13])
  h.now(0)
  h.p(0).pos = 15
  h.roll(0, [[1, 1]]) // → 17 Chest
  h.eq(h.s.phase, 'DEBT', 'Cho cannot pay her $10')
  h.eq(allowedActions(h.s, h.id(1)).length, 0, 'everyone else is frozen while a debt resolves')
  h.eq(h.p(0).cash, 1510, 'collected from Ben, who could afford it')
  h.ok(h.act(2, { type: 'mortgage', space: 11 }), 'Cho mortgages St. Charles')
  h.ok(h.act(2, { type: 'payDebt' }), 'and pays')
  h.eq(h.s.phase, 'DEBT', 'the queued debt (Dara) is now active')
  h.ok(h.act(3, { type: 'mortgage', space: 13 }), 'Dara mortgages States')
  h.ok(h.act(3, { type: 'payDebt' }), 'and pays')
  h.eq(h.p(0).cash, 1530, 'host collected from everyone in the end')
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
  h.bad(h.act(1, { type: 'respondTrade', tradeId: 'nope', accept: true }), 'no such offer')
  h.bad(h.act(1, { type: 'bid', amount: 5 }), 'no auction running')
  h.eq(allowedActions(h.s, h.id(1)).includes('roll'), false, 'only the current player rolls')
  h.eq(allowedActions(h.s, h.id(0)).includes('roll'), true, 'the current player may roll')
  h.eq(allowedActions(h.s, 'ghost').length, 0, 'unknown player')
})

// ── summary ──
if (failures.length > 0) {
  console.log(`\n✗ ${failures.length} failure(s) of ${totalChecks + failures.length} checks:`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
} else {
  console.log(`\n✔ all scenarios passed (${totalChecks} checks)`)
}
