// ── Bot brain ──
// One random-action brain shared by the CLI fuzzer (sim.ts) and the browser
// simulator page. Bots pick a weighted-random action from their ALLOWED list
// (the same list the server enforces), with plausible payloads.

import { BOARD, groupIndices, isStreet } from './board.js'
import { allowedActions, alivePlayers, canBuildOn, canMortgageOn, canSellHouseOn, canUnmortgageOn, ownedSpaces } from './rules.js'
import type { Action, ActionType, GameState, TradeSide } from './types.js'

const WEIGHTS: Partial<Record<ActionType, number>> = {
  roll: 40,
  drawCard: 80, // bots open the chest / spin immediately
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

function pickWeighted(acts: ActionType[], rng: () => number = Math.random): ActionType {
  const items = acts.map((t) => ({ t, w: WEIGHTS[t] ?? 1 }))
  const total = items.reduce((a, b) => a + b.w, 0)
  let r = rng() * total
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

function randomTrade(s: GameState, pid: string, rng: () => number): Action | null {
  const me = s.players.find((p) => p.id === pid)
  const partner = alivePlayers(s).find((q) => q.id !== pid)
  if (!me || !partner) return null
  const mine = tradableSpaces(s, pid)
  const theirs = tradableSpaces(s, partner.id)
  const giveSpaces = mine.filter(() => rng() < 0.4)
  const recvSpaces = theirs.filter(() => rng() < 0.3)
  const give: TradeSide = { cash: Math.floor(rng() * Math.min(200, me.cash)), spaces: giveSpaces, jailCards: 0 }
  const receive: TradeSide = { cash: Math.floor(rng() * Math.min(200, partner.cash)), spaces: recvSpaces, jailCards: 0 }
  if (give.cash === 0 && give.spaces.length === 0 && receive.cash === 0 && receive.spaces.length === 0) return null
  return { type: 'proposeTrade', to: partner.id, give, receive }
}

// Returns a legal-shaped action for the bot to attempt, or null if the bot
// has nothing sensible to do this tick. Payloads may still be rejected by
// the engine's detailed validation — callers should tolerate that.
// `rng` is injectable so the CLI fuzzer can replay a seed exactly.
export function botAction(s: GameState, pid: string, rng: () => number = Math.random): Action | null {
  const acts = allowedActions(s, pid)
  if (acts.length === 0) return null
  const p = s.players.find((q) => q.id === pid)
  if (!p) return null
  const type = pickWeighted(acts, rng)

  switch (type) {
    case 'bid': {
      const au = s.auction
      if (!au) return null
      const bump = 1 + Math.floor(rng() * 40)
      return { type: 'bid', amount: Math.min(au.bid + bump, p.cash) }
    }
    case 'buyHouse':
    case 'sellHouse':
    case 'mortgage':
    case 'unmortgage': {
      const filter =
        type === 'buyHouse' ? canBuildOn
        : type === 'sellHouse' ? canSellHouseOn
        : type === 'mortgage' ? canMortgageOn
        : canUnmortgageOn
      const cands = ownedSpaces(s, pid).filter((i) => filter(s, pid, i))
      if (cands.length === 0) return null
      return { type, space: cands[Math.floor(rng() * cands.length)] }
    }
    case 'payTax':
      return { type: 'payTax', choice: rng() < 0.5 ? 'flat' : 'percent' }
    case 'proposeTrade':
      return randomTrade(s, pid, rng)
    case 'respondTrade': {
      const t = s.trades.find((x) => x.to === pid)
      return t ? { type: 'respondTrade', tradeId: t.id, accept: rng() < 0.35 } : null
    }
    case 'cancelTrade': {
      const t = s.trades.find((x) => x.from === pid)
      return t ? { type: 'cancelTrade', tradeId: t.id } : null
    }
    default:
      return { type } as Action
  }
}

// Whose turn should the bot brain act for? Bias toward whoever the game is
// waiting on, so simulations actually march forward.
export function botActor(s: GameState, rng: () => number = Math.random): string | null {
  const actors = alivePlayers(s).filter((q) => allowedActions(s, q.id).length > 0)
  if (actors.length === 0) return null
  const cur = s.players.find((p) => p.id === s.currentPlayerId)
  if (cur && actors.includes(cur) && rng() < 0.85) return cur.id
  return actors[Math.floor(rng() * actors.length)].id
}
