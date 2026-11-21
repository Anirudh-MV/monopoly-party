// Pure rules helpers that operate on any RulesState (GameState, HostView, PlayerView).
// The server validates with these; phones compute their buttons with the exact
// same functions — one source of truth for "what can I do right now".

import { BOARD, JAIL_FINE, groupIndices, isStreet, RAIL_INDICES, UTILITY_INDICES } from './board.js'
import type { ActionType, ColorGroup, PlayerState, RulesState, TradeOffer } from './types.js'

export function byId(s: RulesState, id: string): PlayerState | undefined {
  return s.players.find((p) => p.id === id)
}

export function current(s: RulesState): PlayerState | undefined {
  return byId(s, s.currentPlayerId)
}

export function alivePlayers(s: RulesState): PlayerState[] {
  return s.players.filter((p) => !p.bankrupt)
}

export function ownedSpaces(s: RulesState, pid: string): number[] {
  const out: number[] = []
  for (const [i, st] of Object.entries(s.props)) if (st.owner === pid) out.push(Number(i))
  return out
}

export function ownsGroup(s: RulesState, pid: string, group: ColorGroup): boolean {
  const g = groupIndices(group)
  return g.every((i) => s.props[i].owner === pid)
}

export function countOwned(s: RulesState, pid: string, kind: 'rail' | 'utility'): number {
  const idx = kind === 'rail' ? RAIL_INDICES : UTILITY_INDICES
  return idx.filter((i) => s.props[i].owner === pid).length
}

export function netWorth(s: RulesState, pid: string): number {
  const p = byId(s, pid)
  let w = p ? p.cash : 0
  for (const [iStr, st] of Object.entries(s.props)) {
    if (st.owner !== pid) continue
    const sp = BOARD[Number(iStr)]
    if ('price' in sp) {
      w += sp.price // official: mortgaged property still counts at printed price
      if (isStreet(sp)) w += st.houses * sp.houseCost
    }
  }
  return w
}

export function rentFor(
  s: RulesState,
  i: number,
  diceSum: number,
  opts: { railMult?: number; utilMult?: number } = {},
): number {
  const sp = BOARD[i]
  if (!sp) return 0
  const st = s.props[i]
  if (!st) return 0
  const owner = st.owner
  if (!owner) return 0
  if (isStreet(sp)) {
    if (st.houses > 0) return sp.rents[st.houses]
    return ownsGroup(s, owner, sp.group) ? sp.rents[0] * 2 : sp.rents[0]
  }
  if (sp.kind === 'rail') {
    const n = countOwned(s, owner, 'rail')
    const base = 25 * Math.pow(2, Math.max(0, n - 1))
    return (opts.railMult ?? 1) * base
  }
  if (sp.kind === 'utility') {
    if (opts.utilMult) return diceSum * opts.utilMult
    const n = countOwned(s, owner, 'utility')
    return diceSum * (n === 2 ? 10 : 4)
  }
  return 0
}

// Lift a mortgage: mortgage value (price/2) + 10% interest, in exact integer math
// (avoid Math.ceil(price * 0.55) — float epsilon makes 100 → 56).
export const unmortgageCost = (price: number): number => Math.floor(price / 2) + Math.ceil(price / 20)

export function canBuildOn(s: RulesState, pid: string, i: number): boolean {
  const sp = BOARD[i]
  if (!sp || !isStreet(sp)) return false
  const st = s.props[i]
  const p = byId(s, pid)
  if (!p || st.owner !== pid) return false
  const g = groupIndices(sp.group)
  if (!ownsGroup(s, pid, sp.group)) return false
  if (g.some((j) => s.props[j].mortgaged)) return false
  if (st.houses >= 5) return false
  const minH = Math.min(...g.map((j) => s.props[j].houses))
  if (st.houses > minH) return false // must build evenly
  return p.cash >= sp.houseCost
}

export function canSellHouseOn(s: RulesState, pid: string, i: number): boolean {
  const sp = BOARD[i]
  if (!sp || !isStreet(sp)) return false
  const st = s.props[i]
  if (st.owner !== pid || st.houses <= 0) return false
  const g = groupIndices(sp.group)
  const maxH = Math.max(...g.map((j) => s.props[j].houses))
  return st.houses >= maxH // must sell evenly (from the most-developed first)
}

export function canMortgageOn(s: RulesState, pid: string, i: number): boolean {
  const sp = BOARD[i]
  if (!sp || !('price' in sp)) return false
  const st = s.props[i]
  if (st.owner !== pid || st.mortgaged) return false
  if (isStreet(sp) && groupIndices(sp.group).some((j) => s.props[j].houses > 0)) return false
  return true
}

export function canUnmortgageOn(s: RulesState, pid: string, i: number): boolean {
  const sp = BOARD[i]
  if (!sp || !('price' in sp)) return false
  const st = s.props[i]
  if (st.owner !== pid || !st.mortgaged) return false
  const p = byId(s, pid)
  return !!p && p.cash >= unmortgageCost(sp.price)
}

// ── The single source of truth for what a player may do right now ──
export function allowedActions(s: RulesState, pid: string): ActionType[] {
  const p = byId(s, pid)
  if (!p || p.bankrupt) return []
  const out = new Set<ActionType>()

  if (s.phase === 'AUCTION') {
    const a = s.auction
    if (!a) return []
    if (a.bidder !== pid && !a.passed.includes(pid)) {
      if (p.cash > a.bid) out.add('bid')
      out.add('passBid')
    }
    return [...out]
  }

  if (s.phase === 'DEBT') {
    const d = s.debt
    if (!d || d.debtor !== pid) return []
    if (p.cash >= d.amount) out.add('payDebt')
    out.add('bankrupt')
    for (const i of ownedSpaces(s, pid)) {
      if (canSellHouseOn(s, pid, i)) out.add('sellHouse')
      if (canMortgageOn(s, pid, i)) out.add('mortgage')
    }
    return [...out]
  }

  if (s.phase !== 'ROLL' && s.phase !== 'ACTION') return []

  // Property management: any living player, any time between rolls (official).
  for (const i of ownedSpaces(s, pid)) {
    if (canBuildOn(s, pid, i)) out.add('buyHouse')
    if (canSellHouseOn(s, pid, i)) out.add('sellHouse')
    if (canMortgageOn(s, pid, i)) out.add('mortgage')
    if (canUnmortgageOn(s, pid, i)) out.add('unmortgage')
  }

  // Trading: also official — deals can be struck between turns.
  out.add('proposeTrade')
  if (s.trades.some((t: TradeOffer) => t.to === pid)) out.add('respondTrade')
  if (s.trades.some((t: TradeOffer) => t.from === pid)) out.add('cancelTrade')

  if (s.phase === 'ROLL' && s.currentPlayerId === pid) {
    out.add('roll')
    if (p.jail) {
      if (p.cash >= JAIL_FINE) out.add('payJail')
      if (p.jailCards > 0) out.add('useJailCard')
    }
  }

  if (s.phase === 'ACTION' && s.currentPlayerId === pid) {
    if (s.pendingCardDraw) {
      out.add('drawCard')
    } else if (s.pendingPurchase != null) {
      const sp = BOARD[s.pendingPurchase]
      const price = 'price' in sp ? sp.price : Infinity
      if (p.cash >= price) out.add('buy')
      out.add('declineBuy')
    } else if (s.pendingTax) {
      out.add('payTax')
    } else {
      out.add('endTurn')
    }
  }

  return [...out]
}
