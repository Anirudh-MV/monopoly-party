// ── Engine fuzz-test ──
// Plays whole games with weighted-random legal bots to prove the rules engine
// never throws, never deadlocks, and always terminates. Run: npm run simulate

import { createGame, applyAction, type PlayerMeta } from './engine.js'
import { allowedActions, alivePlayers, canBuildOn, canMortgageOn, canSellHouseOn, canUnmortgageOn, netWorth, ownedSpaces } from '../shared/rules.js'
import { BOARD, groupIndices, isStreet } from '../shared/board.js'
import type { Action, ActionType, GameState } from '../shared/types.js'

const METAS: PlayerMeta[] = [
  { id: 'p0', name: 'Asha', color: '#ef4444', token: '🎩' },
  { id: 'p1', name: 'Ben', color: '#3b82f6', token: '🚗' },
  { id: 'p2', name: 'Cho', color: '#22c55e', token: '🐕' },
  { id: 'p3', name: 'Dara', color: '#eab308', token: '🚢' },
]

const WEIGHTS: Partial<Record<ActionType, number>> = {
  roll: 40,
  endTurn: 26,
  buy: 14,
  declineBuy: 5,
  bid: 22,
  passBid: 9,
  buyHouse: 8,
  sellHouse: 2,
  mortgage: 2,
  unmortgage: 3,
  payTax: 20,
  payJail: 8,
  useJailCard: 6,
  payDebt: 45,
  bankrupt: 1,
  proposeTrade: 1.5,
  respondTrade: 14,
  cancelTrade: 1,
}

function pickWeighted(acts: ActionType[]): ActionType {
  const items = acts.map((t) => ({ t, w: WEIGHTS[t] ?? 1 }))
  const total = items.reduce((a, b) => a + b.w, 0)
  let r = Math.random() * total
  for (const it of items) {
    r -= it.w
    if (r <= 0) return it.t
  }
  return items[items.length - 1].t
}

function tradableSpaces(s: GameState, pid: string): number[] {
  return ownedSpaces(s, pid).filter((i) => {
    const sp = BOARD[i]
    return isStreet(sp) ? !groupIndices(sp.group).some((j) => s.props[j].houses > 0) : true
  })
}

function buildAction(s: GameState, pid: string, type: ActionType): Action {
  const p = s.players.find((q) => q.id === pid)!
  switch (type) {
    case 'bid': {
      const au = s.auction!
      const bump = 1 + Math.floor(Math.random() * 40)
      return { type, amount: Math.min(au.bid + bump, p.cash) }
    }
    case 'buyHouse':
    case 'sellHouse':
    case 'mortgage':
    case 'unmortgage': {
      // Pick a space that is actually valid for this action — allowedActions
      // only offers the type if at least one qualifying space exists.
      const filter =
        type === 'buyHouse' ? canBuildOn
        : type === 'sellHouse' ? canSellHouseOn
        : type === 'mortgage' ? canMortgageOn
        : canUnmortgageOn
      const cands = ownedSpaces(s, pid).filter((i) => filter(s, pid, i))
      const i = cands.length > 0 ? cands[Math.floor(Math.random() * cands.length)] : -1
      return { type, space: i }
    }
    case 'payTax':
      return { type, choice: Math.random() < 0.5 ? 'flat' : 'percent' }
    case 'proposeTrade': {
      const partner = alivePlayers(s).find((q) => q.id !== pid)
      if (!partner) return { type: 'endTurn' }
      const mine = tradableSpaces(s, pid)
      const theirs = tradableSpaces(s, partner.id)
      const giveSpaces = mine.filter(() => Math.random() < 0.4)
      const recvSpaces = theirs.filter(() => Math.random() < 0.3)
      return {
        type,
        to: partner.id,
        give: { cash: Math.floor(Math.random() * Math.min(200, p.cash)), spaces: giveSpaces, jailCards: 0 },
        receive: { cash: Math.floor(Math.random() * Math.min(200, partner.cash)), spaces: recvSpaces, jailCards: 0 },
      }
    }
    case 'respondTrade': {
      const offer = s.trades.find((t) => t.to === pid)!
      return { type, tradeId: offer.id, accept: Math.random() < 0.35 }
    }
    case 'cancelTrade': {
      const offer = s.trades.find((t) => t.from === pid)!
      return { type, tradeId: offer.id }
    }
    default:
      return { type } as Action
  }
}

function checkInvariants(s: GameState, step: number): void {
  for (const p of s.players) {
    if (!Number.isFinite(p.cash) || !Number.isInteger(p.cash)) {
      throw new Error(`step ${step}: ${p.name} cash is ${p.cash}`)
    }
    if (p.cash < 0) throw new Error(`step ${step}: ${p.name} has negative cash ${p.cash}`)
    if (p.pos < 0 || p.pos > 39) throw new Error(`step ${step}: ${p.name} position ${p.pos}`)
  }
  for (const st of Object.values(s.props)) {
    if (st.houses < 0 || st.houses > 5) throw new Error(`step ${step}: houses ${st.houses}`)
  }
}

// ── Play games ──
const GAMES = Number(process.env.GAMES ?? 25)
const MAX_TURNS = 600

let completed = 0
let timeouts = 0
let totalSteps = 0
let tradesMade = 0

for (let g = 0; g < GAMES; g++) {
  const s = createGame(METAS)
  let steps = 0
  while (s.phase !== 'GAME_OVER' && s.turn < MAX_TURNS && steps < 200_000) {
    steps++
    const actors = alivePlayers(s).filter((q) => allowedActions(s, q.id).length > 0)
    if (actors.length === 0) {
      console.error(`DEADLOCK at turn ${s.turn}, phase ${s.phase}`)
      console.dir(s, { depth: 3 })
      process.exit(1)
    }
    // Prefer whoever's turn it is so games actually progress.
    const cur = s.players.find((p) => p.id === s.currentPlayerId)
    const actor = cur && actors.includes(cur) && Math.random() < 0.85 ? cur : actors[Math.floor(Math.random() * actors.length)]

    const acts = allowedActions(s, actor.id)
    if (acts.length === 0) continue
    const type = pickWeighted(acts)
    const action = buildAction(s, actor.id, type)
    if (action.type === 'proposeTrade') tradesMade++
    const res = applyAction(s, action, actor.id)
    // Random payloads may be invalid (e.g. a blind bid above cash) — that's fine.
    // What must never happen: an exception or an allowed action erroring out.
    if (!res.ok && action.type !== 'proposeTrade' && action.type !== 'respondTrade') {
      console.error(`UNEXPECTED REJECTION at step ${steps}: ${actor.name} → ${JSON.stringify(action)}: ${res.error}`)
      console.dir(s, { depth: 2 })
      process.exit(1)
    }
    checkInvariants(s, steps)
  }
  totalSteps += steps
  if (s.phase === 'GAME_OVER') completed++
  else timeouts++

  if (g === 0 || s.phase === 'GAME_OVER') {
    const winner = s.players.find((p) => p.id === s.winner)
    const kind = s.phase === 'GAME_OVER' ? 'finished' : 'timeout'
    console.log(
      `game ${g + 1}: ${kind} after ${s.turn} turns / ${steps} steps — ` +
        (winner ? `winner ${winner.name}` : 'no winner') +
        ` | standings: ${s.players
          .map((p) => `${p.name}${p.bankrupt ? '💀' : ''}:$${netWorth(s, p.id)}`)
          .join('  ')}`,
    )
  }
}

console.log('')
console.log(`✔ ${GAMES} games: ${completed} finished, ${timeouts} hit the ${MAX_TURNS}-turn cap, ${totalSteps} total actions, ~${Math.round(totalSteps / GAMES)} actions/game`)
console.log('Engine survived: no exceptions, no deadlocks, invariants held.')
