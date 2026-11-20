// ── Monopoly rules engine ──
// A deterministic state machine: applyAction(state, action, playerId, rng).
// No I/O, no sockets — the room layer clones state, applies, re-broadcasts.
// The simulator (sim.ts) drives thousands of random legal actions through this.

import {
  BOARD,
  GO_REWARD,
  JAIL_FINE,
  JAIL_POS,
  MAX_JAIL_ATTEMPTS,
  START_CASH,
  isStreet,
  nearestOf,
  groupIndices,
} from './board.js'
import { ALL_CARDS, CHANCE_JAIL_CARD_ID, CHEST_JAIL_CARD_ID, cardById } from './cards.js'
import * as R from './rules.js'
import type {
  Action,
  Card,
  CardEffect,
  GameState,
  LogEntry,
  PlayerState,
  PropertyState,
  TradeSide,
} from './types.js'

export type Result = { ok: true } | { ok: false; error: string }
const OK: Result = { ok: true }
function fail(error: string): Result {
  return { ok: false, error }
}

export interface PlayerMeta {
  id: string
  name: string
  color: string
  token: string
}

export function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function roll1(rng: () => number): number {
  return 1 + Math.floor(rng() * 6)
}

function log(s: GameState, text: string, kind: LogEntry['kind'] = 'info'): void {
  s.log.push({ text, kind })
}

export function createGame(players: PlayerMeta[], rng: () => number = Math.random): GameState {
  const s: GameState = {
    phase: 'ROLL',
    players: players.map((m) => ({
      ...m,
      cash: START_CASH,
      pos: 0,
      jail: false,
      jailRolls: 0,
      jailCards: 0,
      bankrupt: false,
      connected: true,
    })),
    currentPlayerId: players[0].id,
    dice: null,
    doubles: 0,
    props: {},
    chanceDeck: shuffle(
      ALL_CARDS.filter((c) => c.deck === 'chance').map((c) => c.id),
      rng,
    ),
    chestDeck: shuffle(
      ALL_CARDS.filter((c) => c.deck === 'chest').map((c) => c.id),
      rng,
    ),
    pendingCard: null,
    pendingPurchase: null,
    pendingTax: null,
    pendingMove: null,
    auction: null,
    auctionQueue: [],
    debt: null,
    debtQueue: [],
    trades: [],
    lastLanded: null,
    deadline: null,
    deadlineFor: null,
    log: [],
    turn: 1,
    winner: null,
  }
  for (const [i, sp] of BOARD.entries()) {
    if ('price' in sp) s.props[i] = { owner: null, houses: 0, mortgaged: false }
  }
  log(s, `🎲 Game on! ${players[0].name} rolls first.`, 'good')
  return s
}

// ── Money flow ──

function charge(s: GameState, payer: PlayerState, amount: number, creditor: string | null): void {
  if (amount <= 0) return
  if (payer.cash >= amount) {
    payer.cash -= amount
    if (creditor) {
      const c = R.byId(s, creditor)
      if (c) c.cash += amount
    }
    return
  }
  // Can't pay now — freeze the game until the debtor raises funds or goes bankrupt.
  const d = { debtor: payer.id, amount, creditor }
  if (s.debt) s.debtQueue.push(d)
  else {
    s.debt = d
    s.phase = 'DEBT'
  }
  log(s, `⚠ ${payer.name} owes $${amount}${creditor ? ` to ${R.byId(s, creditor)?.name}` : ' to the bank'} and must raise funds`, 'bad')
}

// ── Phase bookkeeping ──

function advancePhase(s: GameState): void {
  if (s.phase === 'GAME_OVER') return
  if (s.debt) {
    s.phase = 'DEBT'
    return
  }
  if (s.pendingPurchase != null || s.pendingTax != null) {
    s.phase = 'ACTION'
    return
  }
  const cur = R.current(s)
  if (!cur || cur.bankrupt) {
    nextPlayer(s)
    return
  }
  // Doubles roll again — unless this roll already sent them to jail.
  const bonus = s.dice != null && s.dice[0] === s.dice[1] && s.doubles > 0 && s.doubles < MAX_JAIL_ATTEMPTS && !cur.jail
  s.phase = bonus ? 'ROLL' : 'ACTION'
}

function nextPlayer(s: GameState): void {
  s.dice = null
  s.doubles = 0
  s.pendingCard = null
  s.pendingMove = null
  const order = s.players
  const k = order.findIndex((q) => q.id === s.currentPlayerId)
  for (let step = 1; step <= order.length; step++) {
    const cand = order[(k + step) % order.length]
    if (cand && !cand.bankrupt) {
      s.currentPlayerId = cand.id
      break
    }
  }
  s.turn++
  s.phase = 'ROLL'
}

function resumeAfterDebt(s: GameState, rng: () => number): void {
  if (s.phase === 'GAME_OVER') return
  const nextDebt = s.debtQueue.shift()
  if (nextDebt) {
    s.debt = nextDebt
    s.phase = 'DEBT'
    return
  }
  const auctionSpace = s.auctionQueue.shift()
  if (auctionSpace != null) {
    startAuction(s, auctionSpace)
    return
  }
  if (s.pendingMove != null) {
    const steps = s.pendingMove
    s.pendingMove = null
    advance(s, steps, rng)
    return
  }
  advancePhase(s)
}

// ── Movement & landing ──

function advance(s: GameState, steps: number, rng: () => number): void {
  const p = R.current(s)
  if (!p) return
  const np = (p.pos + steps + BOARD.length) % BOARD.length
  if (np < p.pos) {
    p.cash += GO_REWARD
    log(s, `${p.name} passed GO and collected $${GO_REWARD}`, 'money')
  }
  p.pos = np
  land(s, p, {}, rng)
  advancePhase(s)
}

function sendToJail(s: GameState, p: PlayerState): void {
  p.pos = JAIL_POS
  p.jail = true
  p.jailRolls = 0
  log(s, `${p.name} was thrown in jail! 🚔`, 'bad')
}

function land(s: GameState, p: PlayerState, opts: { railMult?: number; utilMult?: number }, rng: () => number): void {
  const i = p.pos
  const sp = BOARD[i]
  // Spotlight for the TV: this is what everyone just saw the piece hit.
  s.lastLanded = { playerId: p.id, space: i }
  switch (sp.kind) {
    case 'go':
    case 'parking':
    case 'jail': // just visiting
      break
    case 'gotojail':
      sendToJail(s, p)
      break
    case 'chance':
      drawCard(s, 'chance', p, rng)
      break
    case 'chest':
      drawCard(s, 'chest', p, rng)
      break
    case 'tax':
      if (sp.percent) {
        s.pendingTax = { player: p.id, space: i }
        log(s, `${p.name} landed on Income Tax — flat $${sp.flat} or 10% of worth?`)
      } else {
        log(s, `${p.name} pays $${sp.flat} Luxury Tax`, 'money')
        charge(s, p, sp.flat, null)
      }
      break
    default:
      handleProperty(s, p, i, opts)
  }
}

function handleProperty(s: GameState, p: PlayerState, i: number, opts: { railMult?: number; utilMult?: number }): void {
  const st: PropertyState | undefined = s.props[i]
  if (!st) return
  const sp = BOARD[i]
  if (!('price' in sp)) return
  if (st.owner == null) {
    s.pendingPurchase = i
    log(s, `${p.name} landed on unowned ${sp.name} ($${sp.price})`)
    return
  }
  if (st.owner === p.id) return
  if (st.mortgaged) {
    log(s, `${sp.name} is mortgaged — no rent collected`)
    return
  }
  const diceSum = s.dice ? s.dice[0] + s.dice[1] : 7
  const rent = R.rentFor(s, i, diceSum, opts)
  if (rent <= 0) return
  const owner = R.byId(s, st.owner)
  log(s, `${p.name} pays $${rent} rent to ${owner?.name ?? 'the owner'}`, 'money')
  charge(s, p, rent, st.owner)
}

// ── Cards ──

function rebuildDeck(s: GameState, deck: 'chance' | 'chest'): void {
  // Only jail cards ever leave a deck (held by a player), so exclude them here.
  const jailId = deck === 'chance' ? CHANCE_JAIL_CARD_ID : CHEST_JAIL_CARD_ID
  const ids = ALL_CARDS.filter((c) => c.deck === deck)
    .map((c) => c.id)
    .filter((id) => id !== jailId)
  if (deck === 'chance') s.chanceDeck = shuffle(ids, Math.random)
  else s.chestDeck = shuffle(ids, Math.random)
}

function drawCard(s: GameState, deck: 'chance' | 'chest', p: PlayerState, rng: () => number): void {
  const key = deck === 'chance' ? 'chanceDeck' : 'chestDeck'
  let id = s[key].shift()
  if (!id) {
    rebuildDeck(s, deck)
    id = s[key].shift()
  }
  if (!id) return
  const card = cardById(id)
  s.pendingCard = card
  log(s, `${p.name} draws: “${card.text}”`)
  applyCard(s, p, card, rng)
}

function returnJailCardsToDecks(s: GameState, count: number): void {
  let left = count
  if (left > 0 && !s.chanceDeck.includes(CHANCE_JAIL_CARD_ID)) {
    s.chanceDeck.push(CHANCE_JAIL_CARD_ID)
    left--
  }
  if (left > 0 && !s.chestDeck.includes(CHEST_JAIL_CARD_ID)) {
    s.chestDeck.push(CHEST_JAIL_CARD_ID)
    left--
  }
}

function applyCard(s: GameState, p: PlayerState, card: Card, rng: () => number): void {
  const e: CardEffect = card.effect
  switch (e.kind) {
    case 'goto': {
      if (e.target < p.pos) {
        p.cash += GO_REWARD
        log(s, `${p.name} passed GO (+$${GO_REWARD})`, 'money')
      }
      p.pos = e.target
      land(s, p, {}, rng)
      break
    }
    case 'move': {
      p.pos = (p.pos + e.steps + BOARD.length) % BOARD.length
      land(s, p, {}, rng)
      break
    }
    case 'nearest': {
      const t = nearestOf(e.target, p.pos)
      if (t < p.pos) {
        p.cash += GO_REWARD
        log(s, `${p.name} passed GO (+$${GO_REWARD})`, 'money')
      }
      p.pos = t
      if (e.target === 'rail') {
        land(s, p, { railMult: 2 }, rng)
      } else {
        const d1 = roll1(rng)
        const d2 = roll1(rng)
        s.dice = [d1, d2]
        log(s, `Fresh utility roll: ${d1} + ${d2}`)
        land(s, p, { utilMult: 10 }, rng)
      }
      break
    }
    case 'money': {
      p.cash += e.amount
      log(s, `${p.name} collects $${e.amount}`, 'money')
      break
    }
    case 'pay': {
      log(s, `${p.name} pays $${e.amount}`, 'money')
      charge(s, p, e.amount, null)
      break
    }
    case 'collectEach': {
      for (const q of R.alivePlayers(s)) {
        if (q.id !== p.id) charge(s, q, e.amount, p.id)
      }
      break
    }
    case 'payEach': {
      for (const q of R.alivePlayers(s)) {
        if (q.id !== p.id) charge(s, p, e.amount, q.id)
      }
      break
    }
    case 'jailcard': {
      p.jailCards++
      log(s, `${p.name} keeps a Get Out of Jail Free card 🎟`, 'good')
      break
    }
    case 'gotojail': {
      sendToJail(s, p)
      break
    }
    case 'repairs': {
      let total = 0
      for (const i of R.ownedSpaces(s, p.id)) {
        const sp = BOARD[i]
        if (!isStreet(sp)) continue
        const h = s.props[i].houses
        total += h === 5 ? e.perHotel : h * e.perHouse
      }
      log(s, `${p.name} pays $${total} for repairs`, 'money')
      charge(s, p, total, null)
      break
    }
  }
}

// ── Auctions ──

function startAuction(s: GameState, space: number): void {
  s.auction = { space, bid: 0, bidder: null, passed: [] }
  s.phase = 'AUCTION'
  log(s, `🔨 ${BOARD[space].name} goes up for auction!`, 'info')
}

function closeAuction(s: GameState): void {
  const au = s.auction
  if (!au) return
  if (au.bidder && au.bid > 0) {
    const w = R.byId(s, au.bidder)
    if (w) {
      w.cash -= au.bid
      s.props[au.space].owner = w.id
      log(s, `🔨 ${w.name} wins ${BOARD[au.space].name} for $${au.bid}`, 'good')
    }
  } else {
    log(s, `No bids — ${BOARD[au.space].name} stays with the bank`)
  }
  s.auction = null
  const next = s.auctionQueue.shift()
  if (next != null) {
    s.auction = { space: next, bid: 0, bidder: null, passed: [] }
    s.phase = 'AUCTION'
    log(s, `🔨 Now auctioning ${BOARD[next].name}`)
  } else {
    advancePhase(s)
  }
}

// Close whenever no one is left who could still outbid: either everyone
// passed, or the last active player just placed their bid.
function checkAuctionClose(s: GameState): void {
  const au = s.auction
  if (!au) return
  const biddersLeft = R.alivePlayers(s).filter((q) => !au.passed.includes(q.id) && q.id !== au.bidder)
  if (biddersLeft.length === 0) closeAuction(s)
}

// ── Bankruptcy ──

function declareBankruptcy(s: GameState, p: PlayerState): Result {
  const d = s.debt
  if (!d || d.debtor !== p.id) return fail('No debt to declare bankruptcy over')
  if (s.phase !== 'DEBT') return fail('Not in debt resolution')

  const cred = d.creditor ? R.byId(s, d.creditor) : undefined

  // Buildings liquidate to the bank at half price; proceeds go to p (then to creditor).
  for (const i of R.ownedSpaces(s, p.id)) {
    const sp = BOARD[i]
    if (isStreet(sp)) {
      const st = s.props[i]
      if (st.houses > 0) {
        p.cash += (st.houses * sp.houseCost) / 2
        st.houses = 0
      }
    }
  }
  if (cred) cred.cash += p.cash
  p.cash = 0

  for (const i of R.ownedSpaces(s, p.id)) {
    const st = s.props[i]
    const sp = BOARD[i]
    if (cred) {
      st.owner = cred.id
      // Official: creditor pays 10% interest on each mortgaged property received.
      if (st.mortgaged && 'price' in sp) {
        const interest = Math.ceil(sp.price / 10)
        if (cred.cash >= interest) {
          cred.cash -= interest
          log(s, `${cred.name} pays $${interest} interest on ${sp.name}`)
        }
      }
    } else {
      st.owner = null
      s.auctionQueue.push(i) // bank-bankruptcy: properties go under the hammer
    }
  }

  if (p.jailCards > 0) {
    if (cred) cred.jailCards += p.jailCards
    else returnJailCardsToDecks(s, p.jailCards)
    p.jailCards = 0
  }

  p.bankrupt = true
  log(s, `💀 ${p.name} is BANKRUPT`, 'bad')
  s.debt = null
  // The bankrupt player's remaining queued obligations die with them
  // (e.g. a "pay each player" card that queued several debts). Their
  // estate already went to the triggering creditor.
  s.debtQueue = s.debtQueue.filter((d2) => d2.debtor !== p.id)
  s.trades = s.trades.filter((t) => t.from !== p.id && t.to !== p.id)

  const alive = R.alivePlayers(s)
  if (alive.length <= 1) {
    s.phase = 'GAME_OVER'
    s.winner = alive[0]?.id ?? null
    s.auction = null
    s.auctionQueue = []
    s.debtQueue = []
    s.pendingPurchase = null
    s.pendingTax = null
    s.pendingMove = null
    log(s, alive[0] ? `🏆 ${alive[0].name} WINS THE GAME!` : 'Everyone went bankrupt.', 'good')
    return OK
  }
  resumeAfterDebt(s, Math.random)
  return OK
}

// ── Trades ──

function validateTradeSide(s: GameState, owner: PlayerState, side: TradeSide): string | null {
  if (side.cash < 0) return 'Cash amount cannot be negative'
  if (side.jailCards < 0) return 'Bad jail-card count'
  if (side.cash > owner.cash) return `${owner.name} can't afford that`
  if (side.jailCards > owner.jailCards) return 'Not enough jail cards'
  if (new Set(side.spaces).size !== side.spaces.length) return 'Duplicate spaces in trade'
  for (const i of side.spaces) {
    const sp = BOARD[i]
    if (!sp || !('price' in sp)) return 'Not a tradable space'
    if (s.props[i].owner !== owner.id) return `${owner.name} doesn't own ${sp.name}`
    if (isStreet(sp) && groupIndices(sp.group).some((j) => s.props[j].houses > 0)) {
      return `Buildings on the ${sp.group} group must be sold first`
    }
  }
  return null
}

// ── The reducer ──

export function applyAction(s: GameState, a: Action, by: string, rng: () => number = Math.random): Result {
  const p = R.byId(s, by)
  if (!p) return fail('Unknown player')

  // Central gate: everything must be on the allowed list.
  if (!R.allowedActions(s, by).includes(a.type)) {
    return fail(`You can't do that right now (${a.type})`)
  }

  switch (a.type) {
    case 'roll': {
      if (s.phase !== 'ROLL' || s.currentPlayerId !== by) return fail('Not your roll')
      const d1 = roll1(rng)
      const d2 = roll1(rng)
      s.dice = [d1, d2]
      log(s, `${p.name} rolls ${d1} + ${d2} = ${d1 + d2}`)

      if (p.jail) {
        if (d1 === d2) {
          p.jail = false
          p.jailRolls = 0
          log(s, `${p.name} rolled doubles and busted out of jail!`, 'good')
          advance(s, d1 + d2, rng) // doubles from jail do NOT grant another roll
        } else {
          p.jailRolls++
          if (p.jailRolls >= MAX_JAIL_ATTEMPTS) {
            p.jail = false
            p.jailRolls = 0
            log(s, `${p.name} failed 3 times — must pay the $${JAIL_FINE} fine`, 'bad')
            charge(s, p, JAIL_FINE, null)
            if (s.debt) {
              s.pendingMove = d1 + d2 // finish the move after the debt is settled
              s.phase = 'DEBT'
              return OK
            }
            advance(s, d1 + d2, rng)
          } else {
            log(s, `${p.name} stays in jail (attempt ${p.jailRolls}/${MAX_JAIL_ATTEMPTS})`)
            s.phase = 'ACTION'
          }
        }
        return OK
      }

      if (d1 === d2) {
        s.doubles++
        if (s.doubles >= MAX_JAIL_ATTEMPTS) {
          log(s, `Three doubles in a row — straight to jail!`, 'bad')
          sendToJail(s, p)
          s.phase = 'ACTION'
          return OK
        }
      }
      advance(s, d1 + d2, rng)
      return OK
    }

    case 'buy': {
      const i = s.pendingPurchase
      if (i == null || s.currentPlayerId !== by) return fail('Nothing to buy')
      const sp = BOARD[i]
      if (!('price' in sp)) return fail('Not for sale')
      if (p.cash < sp.price) return fail('Not enough cash')
      p.cash -= sp.price
      s.props[i].owner = by
      s.pendingPurchase = null
      log(s, `${p.name} buys ${sp.name} for $${sp.price} 🎉`, 'good')
      advancePhase(s)
      return OK
    }

    case 'declineBuy': {
      const i = s.pendingPurchase
      if (i == null || s.currentPlayerId !== by) return fail('Nothing to decline')
      s.pendingPurchase = null
      startAuction(s, i)
      return OK
    }

    case 'bid': {
      const au = s.auction
      if (!au) return fail('No auction running')
      if (au.passed.includes(by) || au.bidder === by) return fail('You are done bidding on this one')
      if (!Number.isFinite(a.amount) || !Number.isInteger(a.amount)) return fail('Bid must be a whole number')
      if (a.amount <= au.bid) return fail(`Bid at least $${au.bid + 1}`)
      if (a.amount > p.cash) return fail('Not enough cash')
      au.bid = a.amount
      au.bidder = by
      log(s, `${p.name} bids $${a.amount} for ${BOARD[au.space].name}`, 'money')
      checkAuctionClose(s)
      return OK
    }

    case 'passBid': {
      const au = s.auction
      if (!au) return fail('No auction running')
      if (au.bidder === by) return fail('You are the high bidder')
      au.passed.push(by)
      checkAuctionClose(s)
      return OK
    }

    case 'endTurn': {
      if (s.phase !== 'ACTION' || s.currentPlayerId !== by) return fail('You can only end your own turn')
      if (s.pendingPurchase != null || s.pendingTax != null || s.debt) return fail('Resolve the pending action first')
      nextPlayer(s)
      return OK
    }

    case 'buyHouse': {
      const sp = BOARD[a.space]
      if (!sp || !isStreet(sp) || !R.canBuildOn(s, by, a.space)) return fail('Cannot build there')
      p.cash -= sp.houseCost
      s.props[a.space].houses++
      log(s, `${p.name} builds on ${sp.name} ($${sp.houseCost}) 🏠`, 'money')
      return OK
    }

    case 'sellHouse': {
      const sp = BOARD[a.space]
      if (!sp || !isStreet(sp) || !R.canSellHouseOn(s, by, a.space)) return fail('Cannot sell there')
      s.props[a.space].houses--
      p.cash += sp.houseCost / 2
      log(s, `${p.name} sells a house on ${sp.name} (+$${sp.houseCost / 2})`, 'money')
      return OK
    }

    case 'mortgage': {
      const sp = BOARD[a.space]
      if (!sp || !R.canMortgageOn(s, by, a.space)) return fail('Cannot mortgage that')
      s.props[a.space].mortgaged = true
      const value = ('price' in sp ? sp.price : 0) / 2
      p.cash += value
      log(s, `${p.name} mortgages ${sp.name} for $${value} 💤`, 'money')
      return OK
    }

    case 'unmortgage': {
      const sp = BOARD[a.space]
      if (!sp || !R.canUnmortgageOn(s, by, a.space)) return fail('Cannot lift that mortgage')
      const cost = R.unmortgageCost('price' in sp ? sp.price : 0)
      p.cash -= cost
      s.props[a.space].mortgaged = false
      log(s, `${p.name} lifts the mortgage on ${sp.name} (-$${cost})`, 'money')
      return OK
    }

    case 'payTax': {
      const t = s.pendingTax
      if (!t || t.player !== by) return fail('No tax pending')
      const sp = BOARD[t.space]
      if (sp.kind !== 'tax') return fail('Not a tax space')
      const amount = a.choice === 'flat' ? sp.flat : Math.ceil(R.netWorth(s, by) / 10)
      s.pendingTax = null
      log(s, `${p.name} pays Income Tax (${a.choice === 'flat' ? 'flat' : '10% of worth'}): $${amount}`, 'money')
      charge(s, p, amount, null)
      advancePhase(s)
      return OK
    }

    case 'payJail': {
      if (!p.jail || s.phase !== 'ROLL' || s.currentPlayerId !== by) return fail('Not your jail sentence')
      p.cash -= JAIL_FINE
      p.jail = false
      log(s, `${p.name} pays $${JAIL_FINE} and walks out of jail`, 'money')
      return OK
    }

    case 'useJailCard': {
      if (!p.jail || p.jailCards <= 0) return fail('No jail card to use')
      p.jailCards--
      p.jail = false
      returnJailCardsToDecks(s, 1)
      log(s, `${p.name} uses a Get Out of Jail Free card 🎟`, 'good')
      return OK
    }

    case 'payDebt': {
      const d = s.debt
      if (!d || d.debtor !== by) return fail('No debt to pay')
      if (p.cash < d.amount) return fail('Not enough cash yet — mortgage or sell below')
      p.cash -= d.amount
      if (d.creditor) {
        const c = R.byId(s, d.creditor)
        if (c) c.cash += d.amount
      }
      s.debt = null
      log(s, `${p.name} settles the debt of $${d.amount}`, 'good')
      resumeAfterDebt(s, rng)
      return OK
    }

    case 'bankrupt': {
      return declareBankruptcy(s, p)
    }

    case 'proposeTrade': {
      if (s.phase !== 'ROLL' && s.phase !== 'ACTION') return fail('No trades right now')
      const t = R.byId(s, a.to)
      if (!t || t.id === by || t.bankrupt) return fail('Bad trade partner')
      const verr = validateTradeSide(s, p, a.give) ?? validateTradeSide(s, t, a.receive)
      if (verr) return fail(verr)
      const id = `t${Date.now()}-${Math.floor(Math.random() * 1000)}`
      s.trades.push({ id, from: by, to: t.id, give: a.give, receive: a.receive })
      log(s, `${p.name} sends a trade offer to ${t.name} 🤝`)
      return OK
    }

    case 'respondTrade': {
      if (s.phase !== 'ROLL' && s.phase !== 'ACTION') return fail('No trades right now')
      const idx = s.trades.findIndex((t) => t.id === a.tradeId && t.to === by)
      if (idx < 0) return fail('No such offer')
      const offer = s.trades[idx]
      const from = R.byId(s, offer.from)
      if (!from) {
        s.trades.splice(idx, 1)
        return fail('Offer is stale')
      }
      if (!a.accept) {
        s.trades.splice(idx, 1)
        log(s, `${p.name} declines the trade`, 'bad')
        return OK
      }
      const verr = validateTradeSide(s, from, offer.give) ?? validateTradeSide(s, p, offer.receive)
      if (verr) {
        s.trades.splice(idx, 1)
        return fail(verr)
      }
      // Apply the swap. Jail cards move too; buildings never trade (validated above).
      from.cash += offer.receive.cash - offer.give.cash
      p.cash += offer.give.cash - offer.receive.cash
      for (const i of offer.give.spaces) s.props[i].owner = p.id
      for (const i of offer.receive.spaces) s.props[i].owner = from.id
      from.jailCards += offer.receive.jailCards - offer.give.jailCards
      p.jailCards += offer.give.jailCards - offer.receive.jailCards
      s.trades.splice(idx, 1)
      log(s, `🤝 Trade accepted: ${from.name} ↔ ${p.name}`, 'good')
      return OK
    }

    case 'cancelTrade': {
      const idx = s.trades.findIndex((t) => t.id === a.tradeId && t.from === by)
      if (idx < 0) return fail('No such offer')
      s.trades.splice(idx, 1)
      log(s, `${p.name} withdraws a trade offer`)
      return OK
    }

    default:
      return fail('Unknown action')
  }
}
