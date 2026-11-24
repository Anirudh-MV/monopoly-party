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
  DebtState,
  GameState,
  JailReason,
  LogEntry,
  MoneyEvent,
  PlayerState,
  PropertyState,
  TradeSide,
} from './types.js'
import { JAIL_REASONS, type PendingJail } from './types.js'

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

// ── Money ledger ──
// Every cash movement in the game flows through here, so any player can
// open the books and see exactly where everyone's money went.
function logMoney(s: GameState, pid: string, delta: number, memo: string): void {
  if (delta === 0) return
  const p = R.byId(s, pid)
  const balance = p ? p.cash : 0 // callers log AFTER mutating, so this is post-transaction
  const e: MoneyEvent = { seq: s.ledger.length, turn: s.turn, playerId: pid, delta, memo, balance }
  s.ledger.push(e)
  if (s.ledger.length > 600) s.ledger.splice(0, s.ledger.length - 600)
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
      jailReason: null,
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
    lastMove: null,
    ledger: [],
    deadline: null,
    deadlineFor: null,
    pendingCardDraw: null,
    cardDrawSeq: 0,
    pendingJail: null,
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

// "Prompt before money leaves": a charge NEVER deducts cash on its own. It
// always raises a pending debt with the reason preserved in the memo, so the
// debtor's phone can show a Pay button that names the exact amount. When a
// debt is already active, the new one queues behind it and activates through
// resumeAfterDebt — the warning log belongs to that activation moment, never
// to the queueing one.
function charge(s: GameState, payer: PlayerState, amount: number, creditor: string | null, memo: string): void {
  if (amount <= 0) return
  const d: DebtState = { debtor: payer.id, amount, creditor, memo }
  if (s.debt) {
    s.debtQueue.push(d)
    return
  }
  s.debt = d
  s.phase = 'DEBT'
  warnIfShort(s, d)
}

// The ⚠ line only fires when a debt becomes ACTIVE and the debtor genuinely
// cannot cover it — they must raise funds, and the table should hear about it.
function warnIfShort(s: GameState, d: DebtState): void {
  const payer = R.byId(s, d.debtor)
  if (!payer || payer.cash >= d.amount) return
  log(s, `⚠ ${payer.name} owes $${d.amount}${d.creditor ? ` to ${R.byId(s, d.creditor)?.name}` : ' to the bank'} and must raise funds`, 'bad')
}

// The old instant path, kept ONLY for decisions whose buttons already named
// the amount (income tax's flat/10% choice). Everything else routes through
// the debt-always charge() above.
function instantPay(s: GameState, payer: PlayerState, amount: number, creditor: string | null, memo: string): void {
  if (amount <= 0) return
  payer.cash -= amount
  logMoney(s, payer.id, -amount, memo)
  if (creditor) {
    const c = R.byId(s, creditor)
    if (c) {
      c.cash += amount
      logMoney(s, c.id, amount, `Received from ${payer.name}: ${memo}`)
    }
  }
}

// ── Phase bookkeeping ──

function advancePhase(s: GameState): void {
  if (s.phase === 'GAME_OVER') return
  if (s.debt) {
    s.phase = 'DEBT'
    return
  }
  if (s.pendingPurchase != null || s.pendingTax != null || s.pendingCardDraw != null || s.pendingJail != null) {
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
  s.pendingCardDraw = null
  s.pendingJail = null
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
    // the warning belongs to the moment the debt goes ACTIVE — charge()
    // stayed silent when it was only queued behind another
    warnIfShort(s, nextDebt)
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
    logMoney(s, p.id, GO_REWARD, 'Passed GO')
    log(s, `${p.name} passed GO and collected $${GO_REWARD}`, 'money')
  }
  const path: number[] = []
  for (let k = 1; k <= steps; k++) path.push((p.pos + k) % BOARD.length)
  s.lastMove = { playerId: p.id, path }
  p.pos = np
  land(s, p, {}, rng)
  advancePhase(s)
}

// ── The two-step arrest ──
// Triggers (space / card / triple doubles) only ANNOUNCE the sentence;
// the 'goToJail' action executes it — from the arrested player's phone,
// on a 30-second deadline, so the whole table sees it coming.

function announceJail(s: GameState, p: PlayerState, reason: JailReason): void {
  s.pendingJail = { player: p.id, reason }
  log(s, `${p.name} is under arrest — ${JAIL_REASONS[reason]}`, 'bad')
}

function sendToJail(s: GameState, p: PlayerState, reason: JailReason): void {
  p.pos = JAIL_POS
  p.jail = true
  p.jailRolls = 0
  p.jailReason = JAIL_REASONS[reason]
  s.lastMove = null // a jail ride is a snap, not a stroll
  s.pendingJail = null
  log(s, `${p.name} was taken to jail (${JAIL_REASONS[reason]})`, 'bad')
}

function releaseFromJail(s: GameState, p: PlayerState): void {
  p.jail = false
  p.jailReason = null
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
      announceJail(s, p, 'space')
      break
    case 'chance':
      s.pendingCardDraw = { player: p.id, deck: 'chance', space: i }
      log(s, `${p.name} landed on Chance — spin the wheel!`)
      break
    case 'chest':
      s.pendingCardDraw = { player: p.id, deck: 'chest', space: i }
      log(s, `${p.name} landed on Community Chest — open it!`)
      break
    case 'tax':
      if (sp.percent) {
        s.pendingTax = { player: p.id, space: i }
        log(s, `${p.name} landed on Income Tax — flat $${sp.flat} or 10% of worth?`)
      } else {
        log(s, `${p.name} pays $${sp.flat} Luxury Tax`, 'money')
        charge(s, p, sp.flat, null, 'Luxury tax')
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
  log(s, `${p.name} owes $${rent} rent to ${owner?.name ?? 'the owner'}`, 'money')
  // Rent is paid by hand, never silently deducted: even when affordable it
  // becomes a pending debt with a Pay button on the landing player's phone —
  // the feeling of actually spending the money. When they can't afford it,
  // the existing raise-funds / bankruptcy path takes over from here, and the
  // decision clock auto-pays on expiry so a stalled phone can't stall the table.
  const d: DebtState = { debtor: p.id, amount: rent, creditor: st.owner, memo: `Rent: ${sp.name}` }
  if (s.debt) s.debtQueue.push(d)
  else {
    s.debt = d
    s.phase = 'DEBT'
  }
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
  s.cardDrawSeq++
  log(s, `${deck === 'chance' ? 'Chance' : 'Community Chest'} said: ${card.text}`)
  applyCard(s, p, card, rng)
}

function returnJailCardsToDecks(s: GameState, count: number, decks: Array<'chance' | 'chest'> = []): void {
  // Each card goes back to the deck it came from when known; unknown cards
  // (pre-upgrade snapshots) fall back to "the deck that's missing its
  // card", which is the best guess available.
  for (let i = 0; i < count; i++) {
    const from = decks[i] ?? (s.chanceDeck.includes(CHANCE_JAIL_CARD_ID) ? 'chest' : 'chance')
    const deck = from === 'chance' ? s.chanceDeck : s.chestDeck
    const id = from === 'chance' ? CHANCE_JAIL_CARD_ID : CHEST_JAIL_CARD_ID
    if (!deck.includes(id)) deck.push(id)
  }
}

function applyCard(s: GameState, p: PlayerState, card: Card, rng: () => number): void {
  const e: CardEffect = card.effect
  switch (e.kind) {
    case 'goto': {
      if (e.target < p.pos) {
        p.cash += GO_REWARD
        logMoney(s, p.id, GO_REWARD, 'Passed GO')
        log(s, `${p.name} passed GO (+$${GO_REWARD})`, 'money')
      }
      const steps = (e.target - p.pos + BOARD.length) % BOARD.length
      const path: number[] = []
      for (let k = 1; k <= steps; k++) path.push((p.pos + k) % BOARD.length)
      s.lastMove = { playerId: p.id, path }
      p.pos = e.target
      land(s, p, {}, rng)
      break
    }
    case 'move': {
      const path: number[] = []
      for (let k = 1; k <= Math.abs(e.steps); k++) {
        path.push((p.pos + (e.steps > 0 ? k : -k) + BOARD.length) % BOARD.length)
      }
      s.lastMove = { playerId: p.id, path }
      p.pos = (p.pos + e.steps + BOARD.length) % BOARD.length
      land(s, p, {}, rng)
      break
    }
    case 'nearest': {
      const t = nearestOf(e.target, p.pos)
      if (t < p.pos) {
        p.cash += GO_REWARD
        logMoney(s, p.id, GO_REWARD, 'Passed GO')
        log(s, `${p.name} passed GO (+$${GO_REWARD})`, 'money')
      }
      const steps = (t - p.pos + BOARD.length) % BOARD.length
      const path: number[] = []
      for (let k = 1; k <= steps; k++) path.push((p.pos + k) % BOARD.length)
      s.lastMove = { playerId: p.id, path }
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
      logMoney(s, p.id, e.amount, `Card: ${card.text}`)
      log(s, `${p.name} collects $${e.amount}`, 'money')
      break
    }
    case 'pay': {
      log(s, `${p.name} pays $${e.amount}`, 'money')
      charge(s, p, e.amount, null, `Card: ${card.text}`)
      break
    }
    case 'collectEach': {
      for (const q of R.alivePlayers(s)) {
        if (q.id !== p.id) charge(s, q, e.amount, p.id, `Card: ${card.text}`)
      }
      break
    }
    case 'payEach': {
      for (const q of R.alivePlayers(s)) {
        if (q.id !== p.id) charge(s, p, e.amount, q.id, `Card: ${card.text}`)
      }
      break
    }
    case 'jailcard': {
      p.jailCards++
      // Remember which deck this card came from — a count alone can't say
      // where it belongs when it's used.
      ;(p.jailCardDecks ??= []).push(card.deck)
      log(s, `${p.name} keeps a Get Out of Jail Free card`, 'good')
      break
    }
    case 'gotojail': {
      announceJail(s, p, 'card')
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
      charge(s, p, total, null, `Card: ${card.text}`)
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
      logMoney(s, w.id, -au.bid, `Won ${BOARD[au.space].name} at auction`)
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

// The game ends the moment one player (or nobody) is left unbankrupted.
// Shared by bankruptcy and forfeit; `lastStanding` picks the walk-off
// victory wording.
function checkGameOver(s: GameState, lastStanding = false): boolean {
  const alive = R.alivePlayers(s)
  if (alive.length > 1) return false
  s.phase = 'GAME_OVER'
  s.winner = alive[0]?.id ?? null
  s.auction = null
  s.auctionQueue = []
  s.debtQueue = []
  s.pendingPurchase = null
  s.pendingTax = null
  s.pendingMove = null
  log(
    s,
    alive[0]
      ? lastStanding
        ? `🏆 ${alive[0].name} WINS — last one standing!`
        : `🏆 ${alive[0].name} WINS THE GAME!`
      : 'Everyone went bankrupt.',
    'good',
  )
  return true
}

export function declareBankruptcy(s: GameState, p: PlayerState, lastStanding = false): Result {
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
        const half = (st.houses * sp.houseCost) / 2
        p.cash += half
        logMoney(s, p.id, half, `Liquidated buildings on ${sp.name}`)
        st.houses = 0
      }
    }
  }
  const estate = p.cash
  if (cred) {
    cred.cash += estate
    if (estate > 0) logMoney(s, cred.id, estate, `Estate from ${p.name} (bankruptcy)`)
  }
  p.cash = 0
  // logged after the wipe so the recorded balance is the final $0
  if (cred && estate > 0) logMoney(s, p.id, -estate, `Bankruptcy: estate to ${cred.name}`)

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
          logMoney(s, cred.id, -interest, `Interest on ${sp.name} (bankruptcy transfer)`)
          log(s, `${cred.name} pays $${interest} interest on ${sp.name}`)
        }
      }
    } else {
      st.owner = null
      // The bank repossesses clean: the property goes under the hammer
      // unmortgaged, so the next buyer pays full price for a live deed.
      st.mortgaged = false
      s.auctionQueue.push(i) // bank-bankruptcy: properties go under the hammer
    }
  }

  if (p.jailCards > 0) {
    if (cred) {
      cred.jailCards += p.jailCards
      ;(cred.jailCardDecks ??= []).push(...(p.jailCardDecks ?? []))
    } else {
      returnJailCardsToDecks(s, p.jailCards, p.jailCardDecks ?? [])
    }
    p.jailCards = 0
    p.jailCardDecks = []
  }

  p.bankrupt = true
  log(s, `💀 ${p.name} is BANKRUPT`, 'bad')
  s.debt = null
  // The bankrupt player's remaining queued obligations die with them
  // (e.g. a "pay each player" card that queued several debts). Their
  // estate already went to the triggering creditor.
  // Queued obligations die with them — and any debt they were about to
  // COLLECT pays the bank instead: cash must never land on a dead seat.
  s.debtQueue = s.debtQueue
    .filter((d2) => d2.debtor !== p.id)
    .map((d2) => (d2.creditor === p.id ? { ...d2, creditor: null } : d2))
  s.trades = s.trades.filter((t) => t.from !== p.id && t.to !== p.id)

  // …and so does the rest of their interrupted turn — but ONLY theirs:
  // pendings belonging to a different current player (a live buy decision,
  // an announced arrest) must survive. Without the pendingMove clear, a
  // bankruptcy on the 3rd failed jail roll left it behind: the
  // next debt resolution finished the DEAD player's stroll — possibly
  // collecting GO — and landed them on an offer nobody could act on,
  // freezing the game.
  const isCur = s.currentPlayerId === p.id
  if (isCur) {
    s.pendingMove = null
    s.pendingPurchase = null
    s.pendingTax = null
    s.pendingCard = null
    s.pendingCardDraw = null
  }
  if (s.pendingJail != null && s.pendingJail.player === p.id) s.pendingJail = null

  if (checkGameOver(s, lastStanding)) return OK
  resumeAfterDebt(s, Math.random)
  return OK
}

// ── Forfeit: the one estate rule ──
// A voluntary mid-game walk-out is an immediate bankrupt-to-bank forfeit.
// No creditor is waiting, so nothing changes hands: buildings liquidate
// back to the bank, deeds queue for auction unmortgaged, jail cards go
// back to their decks — and the game carries on, detecting the win
// automatically if nobody else is left. (A leaver with a pending
// PLAYER-debt is routed here by the rooms layer through declareBankruptcy
// instead, so the lender gets paid per the tested rules.)
export function forfeitEstate(s: GameState, pid: string, headline?: string): Result {
  const p = R.byId(s, pid)
  if (!p || p.bankrupt) return fail('Nothing to forfeit')

  for (const i of R.ownedSpaces(s, pid)) {
    const sp = BOARD[i]
    const st = s.props[i]
    // buildings go back to the bank at half price; with no creditor, the
    // proceeds die with the estate. The hammer sells an unmortgaged deed.
    if (isStreet(sp)) st.houses = 0
    st.owner = null
    st.mortgaged = false
    s.auctionQueue.push(i)
  }

  if (p.jailCards > 0) {
    returnJailCardsToDecks(s, p.jailCards, p.jailCardDecks ?? [])
    p.jailCards = 0
    p.jailCardDecks = []
  }
  s.trades = s.trades.filter((t) => t.from !== pid && t.to !== pid)

  p.bankrupt = true
  p.cash = 0
  if (headline) log(s, headline, 'bad')

  // Their interrupted turn and queued obligations die with them — but ONLY
  // theirs. Pendings owned by the CURRENT player (someone else's live buy
  // decision, an announced arrest) must survive the walk-out: a colluding
  // exit must never bail the active player out of jail or a tax bill.
  const isCurrent = s.currentPlayerId === pid
  if (isCurrent) {
    s.pendingMove = null
    s.pendingPurchase = null
    s.pendingTax = null
    s.pendingCard = null
    s.pendingCardDraw = null
  }
  if (s.pendingJail != null && s.pendingJail.player === pid) s.pendingJail = null
  const hadOwnDebt = s.debt != null && s.debt.debtor === pid
  if (hadOwnDebt) s.debt = null // a bank debt dies with the estate
  // Debts the leaver was about to COLLECT pay the bank instead — cash must
  // never land on a dead seat.
  if (s.debt && s.debt.creditor === pid) s.debt = { ...s.debt, creditor: null }
  s.debtQueue = s.debtQueue
    .filter((d) => d.debtor !== pid)
    .map((d) => (d.creditor === pid ? { ...d, creditor: null } : d))

  if (checkGameOver(s, true)) return OK

  if (hadOwnDebt) {
    // Debt machinery was mid-flight for the leaver — hand the flow to the
    // standard resume: queued debts first, then the liquidation auctions.
    resumeAfterDebt(s, Math.random)
    return OK
  }
  const au = s.auction
  if (au) {
    // The leaver was bidding on someone else's auction: drop their bid so
    // the hammer can still fall — a fully-passed auction closes to the bank.
    if (au.bidder === pid) {
      au.bidder = null
      checkAuctionClose(s)
    }
    return OK
  }
  if (s.debt == null && s.auctionQueue.length > 0) {
    // Liquidation auctions start right away — the TV announces the hammer
    // while the walk-out is still the room's hottest news. Any pending
    // decision of the current player survives: advancePhase restores it
    // after the last auction closes.
    startAuction(s, s.auctionQueue.shift()!)
    return OK
  }
  if (s.currentPlayerId === pid) nextPlayer(s)
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
          releaseFromJail(s, p)
          p.jailRolls = 0
          log(s, `${p.name} rolled doubles and busted out of jail!`, 'good')
          advance(s, d1 + d2, rng) // doubles from jail do NOT grant another roll
        } else {
          p.jailRolls++
          if (p.jailRolls >= MAX_JAIL_ATTEMPTS) {
            releaseFromJail(s, p)
            p.jailRolls = 0
            log(s, `${p.name} failed 3 times — must pay the $${JAIL_FINE} fine`, 'bad')
            // charge() always raises a debt now — the stroll is parked until
            // the fine is settled by tap, by the clock, or by bankruptcy.
            charge(s, p, JAIL_FINE, null, 'Jail release fine')
            s.pendingMove = d1 + d2 // finish the move after the debt is settled
            s.phase = 'DEBT'
            return OK
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
          log(s, `Three doubles in a row — the police are on their way!`, 'bad')
          announceJail(s, p, 'doubles')
          advancePhase(s) // pendingJail holds the turn for the 30s arrest
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
      logMoney(s, by, -sp.price, `Bought ${sp.name}`)
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
      if (s.pendingPurchase != null || s.pendingTax != null || s.pendingCardDraw != null || s.pendingJail != null || s.debt) {
        return fail('Resolve the pending action first')
      }
      nextPlayer(s)
      return OK
    }

    case 'goToJail': {
      const j = s.pendingJail
      if (!j || j.player !== by) return fail('No arrest waiting for you')
      sendToJail(s, p, j.reason)
      advancePhase(s)
      return OK
    }

    case 'drawCard': {
      const d = s.pendingCardDraw
      if (!d || d.player !== by) return fail('No card waiting for you')
      s.pendingCardDraw = null
      drawCard(s, d.deck, p, rng)
      advancePhase(s) // a debt from the card freezes play; otherwise back on rails
      return OK
    }

    case 'buyHouse': {
      const sp = BOARD[a.space]
      if (!sp || !isStreet(sp) || !R.canBuildOn(s, by, a.space)) return fail('Cannot build there')
      p.cash -= sp.houseCost
      logMoney(s, by, -sp.houseCost, `Built a house on ${sp.name}`)
      s.props[a.space].houses++
      log(s, `${p.name} builds on ${sp.name} ($${sp.houseCost}) 🏠`, 'money')
      return OK
    }

    case 'sellHouse': {
      const sp = BOARD[a.space]
      if (!sp || !isStreet(sp) || !R.canSellHouseOn(s, by, a.space)) return fail('Cannot sell there')
      s.props[a.space].houses--
      p.cash += sp.houseCost / 2
      logMoney(s, by, sp.houseCost / 2, `Sold a house on ${sp.name}`)
      log(s, `${p.name} sells a house on ${sp.name} (+$${sp.houseCost / 2})`, 'money')
      return OK
    }

    case 'mortgage': {
      const sp = BOARD[a.space]
      if (!sp || !R.canMortgageOn(s, by, a.space)) return fail('Cannot mortgage that')
      s.props[a.space].mortgaged = true
      const value = ('price' in sp ? sp.price : 0) / 2
      p.cash += value
      logMoney(s, by, value, `Mortgaged ${sp.name}`)
      log(s, `${p.name} mortgages ${sp.name} for $${value} 💤`, 'money')
      return OK
    }

    case 'unmortgage': {
      const sp = BOARD[a.space]
      if (!sp || !R.canUnmortgageOn(s, by, a.space)) return fail('Cannot lift that mortgage')
      const cost = R.unmortgageCost('price' in sp ? sp.price : 0)
      p.cash -= cost
      logMoney(s, by, -cost, `Lifted mortgage on ${sp.name}`)
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
      // The choice buttons already named the exact amount, so this is the one
      // payment that may leave instantly — but only when the wallet covers it.
      if (p.cash >= amount) instantPay(s, p, amount, null, 'Income tax')
      else charge(s, p, amount, null, 'Income tax')
      advancePhase(s)
      return OK
    }

    case 'payJail': {
      if (!p.jail || s.phase !== 'ROLL' || s.currentPlayerId !== by) return fail('Not your jail sentence')
      p.cash -= JAIL_FINE
      logMoney(s, by, -JAIL_FINE, 'Paid jail release fine')
      releaseFromJail(s, p)
      log(s, `${p.name} pays $${JAIL_FINE} and walks out of jail`, 'money')
      return OK
    }

    case 'useJailCard': {
      if (!p.jail || p.jailCards <= 0) return fail('No jail card to use')
      p.jailCards--
      releaseFromJail(s, p)
      // The card goes back to the deck it came from — not "the deck that's
      // missing its card", which duplicated one jail card and made the
      // other vanish when both were out at once.
      const decks = p.jailCardDecks ?? []
      const from = decks.shift()
      p.jailCardDecks = decks
      returnJailCardsToDecks(s, 1, from != null ? [from] : [])
      log(s, `${p.name} uses a Get Out of Jail Free card 🎟`, 'good')
      return OK
    }

    case 'payDebt': {
      const d = s.debt
      if (!d || d.debtor !== by) return fail('No debt to pay')
      if (p.cash < d.amount) return fail('Not enough cash yet — mortgage or sell below')
      const memo = d.memo ?? 'Debt settlement'
      const blurb = d.memo ? R.debtBlurb(d) : null
      p.cash -= d.amount
      logMoney(s, by, -d.amount, memo)
      if (d.creditor) {
        const c = R.byId(s, d.creditor)
        if (c) {
          c.cash += d.amount
          logMoney(s, c.id, d.amount, `Received from ${p.name}: ${memo}`)
        }
      }
      s.debt = null
      log(s, blurb ? `${p.name} paid $${d.amount} — ${blurb}` : `${p.name} pays the $${d.amount} they owed`, 'good')
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
      // Caps: a phone can hold 3 open offers, the table 16 — spam would
      // bloat every view pushed to every client, and the clock would tick
      // for a room that's 90% junk.
      if (s.trades.filter((x) => x.from === by).length >= 3) return fail('Withdraw an offer first (max 3 open)')
      if (s.trades.length >= 16) return fail('Too many open offers at the table')
      // Monotonic, collision-free — Date.now() ids could collide.
      s.tradeSeq = (s.tradeSeq ?? 0) + 1
      const id = `t${s.turn}-${s.tradeSeq}`
      s.trades.push({ id, from: by, to: t.id, give: a.give, receive: a.receive })
      log(s, `${p.name} sends a trade offer to ${t.name} 🤝`)
      return OK
    }

    case 'respondTrade': {
      if (s.phase === 'LOBBY' || s.phase === 'GAME_OVER') return fail('No trades right now')
      const idx = s.trades.findIndex((t) => t.id === a.tradeId && t.to === by)
      if (idx < 0) return fail('No such offer')
      const offer = s.trades[idx]
      const from = R.byId(s, offer.from)
      if (!from) {
        s.trades.splice(idx, 1)
        return fail('Offer is stale')
      }
      // Declining is harmless in any live phase — removing an offer can't
      // disturb an auction or a debt resolution, so it stays legal through
      // the freezes (the allowed list ships it; see rules.ts).
      if (!a.accept) {
        s.trades.splice(idx, 1)
        log(s, `${p.name} declines the trade`, 'bad')
        return OK
      }
      // Accepting MOVES money and deeds — that waits for the table to be
      // live again. The offer stays on the table for after the freeze.
      if (s.phase !== 'ROLL' && s.phase !== 'ACTION') {
        return fail('Trades pause until the auction/debt settles')
      }
      const verr = validateTradeSide(s, from, offer.give) ?? validateTradeSide(s, p, offer.receive)
      if (verr) {
        s.trades.splice(idx, 1)
        return fail(verr)
      }
      // Apply the swap. Jail cards move too; buildings never trade (validated above).
      const fromDelta = offer.receive.cash - offer.give.cash
      const toDelta = offer.give.cash - offer.receive.cash
      from.cash += fromDelta
      p.cash += toDelta
      if (fromDelta !== 0) logMoney(s, from.id, fromDelta, `Trade with ${p.name}`)
      if (toDelta !== 0) logMoney(s, p.id, toDelta, `Trade with ${from.name}`)
      for (const i of offer.give.spaces) s.props[i].owner = p.id
      for (const i of offer.receive.spaces) s.props[i].owner = from.id
      from.jailCards += offer.receive.jailCards - offer.give.jailCards
      p.jailCards += offer.give.jailCards - offer.receive.jailCards
      // The deck identities move with the cards, so a traded card still
      // returns to the deck it originally came from.
      const shiftDecks = (loser: PlayerState, n: number, winner: PlayerState): void => {
        if (n <= 0) return
        const moved = (loser.jailCardDecks ?? []).slice(0, n)
        loser.jailCardDecks = (loser.jailCardDecks ?? []).slice(n)
        ;(winner.jailCardDecks ??= []).push(...moved)
      }
      shiftDecks(from, offer.give.jailCards, p)
      shiftDecks(p, offer.receive.jailCards, from)
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
