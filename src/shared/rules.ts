// Pure rules helpers that operate on any RulesState (GameState, HostView, PlayerView).
// The server validates with these; phones compute their buttons with the exact
// same functions — one source of truth for "what can I do right now".

import { BOARD, JAIL_FINE, groupIndices, isStreet, RAIL_INDICES, UTILITY_INDICES } from './board.js'
import type { ActionType, ColorGroup, GameState, PlayerState, RulesState, TradeOffer, WaitingOn } from './types.js'

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

// ── The debt blurb ──
// One short human phrase for WHY a debt exists, built from the ledger memo
// and shared by phones, the TV and the announcer. 'Rent: Boardwalk' becomes
// 'rent for Boardwalk'; card memos drop their instruction tail ("Hospital
// fees. Pay $100." → "Hospital fees"). Deliberately no regex lookbehind —
// the bundles target older iPhones (es2020).
export function debtBlurb(d: { memo?: string } | null | undefined): string {
  const memo = d?.memo
  if (!memo) return 'a debt'
  if (memo === 'Luxury tax') return 'Luxury Tax'
  if (memo === 'Income tax') return 'Income Tax'
  if (memo === 'Jail release fine') return 'jail fine'
  if (memo.startsWith('Rent: ')) return `rent for ${memo.slice(6)}`
  if (memo.startsWith('Card: ')) {
    // Split on '. ' and drop sentences that START with the instruction verbs —
    // never a lookbehind, never a greedy regex on untrusted card text.
    const kept = memo
      .slice(6)
      .split('. ')
      .filter((seg) => {
        const first = seg.trim().toLowerCase().split(/\s+/)[0]?.replace(/[^a-z]/g, '') ?? ''
        return first !== 'pay' && first !== 'collect'
      })
      .join('. ')
      .replace(/[.,;:\s]+$/, '')
    return kept || 'a card fee'
  }
  return memo
}

// Display helper: what this space EARNS right now, and what the next
// investment tier would earn — for landed info and the portfolio.
// `current` for utilities is the dice multiplier (4 or 10), see `note`.
export function rentPreview(s: RulesState, i: number): { current: number; next: number | null; note: string } {
  const sp = BOARD[i]
  const st = s.props[i]
  const owner = st.owner
  if (isStreet(sp)) {
    const doubled = owner != null && ownsGroup(s, owner, sp.group)
    const current = st.houses > 0 ? sp.rents[st.houses] : doubled ? sp.rents[0] * 2 : sp.rents[0]
    const next = st.houses < 5 ? sp.rents[st.houses + 1] : null
    const note = st.houses === 5 ? 'hotel' : doubled && st.houses === 0 ? 'full set — doubled' : ''
    return { current, next, note }
  }
  if (sp.kind === 'rail') {
    const n = owner != null ? countOwned(s, owner, 'rail') : 1
    const current = 25 * Math.pow(2, Math.max(0, n - 1))
    const next = n < 4 ? 25 * Math.pow(2, n) : null
    return { current, next, note: `${n} railroad${n > 1 ? 's' : ''}` }
  }
  if (sp.kind === 'utility') {
    const both = owner != null && countOwned(s, owner, 'utility') === 2
    return { current: both ? 10 : 4, next: both ? null : 10, note: `${both ? '10' : '4'}× dice roll` }
  }
  return { current: 0, next: null, note: '' }
}

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
    // Harmless trade bookkeeping survives the freeze: declining an offer or
    // withdrawing your own removes a row from a list — it can't disturb the
    // auction. (Accepting is a different story — the engine case gates it.)
    if (s.trades.some((t: TradeOffer) => t.to === pid)) out.add('respondTrade')
    if (s.trades.some((t: TradeOffer) => t.from === pid)) out.add('cancelTrade')
    return [...out]
  }

  if (s.phase === 'DEBT') {
    const d = s.debt
    if (!d) return []
    if (d.debtor === pid) {
      if (p.cash >= d.amount) out.add('payDebt')
      out.add('bankrupt')
      for (const i of ownedSpaces(s, pid)) {
        if (canSellHouseOn(s, pid, i)) out.add('sellHouse')
        if (canMortgageOn(s, pid, i)) out.add('mortgage')
      }
    }
    // Same freeze rule as auctions: everyone may still decline/withdraw
    // trade offers — only the debtor is raising funds, the rest of the
    // table shouldn't lose their ability to clear their own offer lists.
    if (s.trades.some((t: TradeOffer) => t.to === pid)) out.add('respondTrade')
    if (s.trades.some((t: TradeOffer) => t.from === pid)) out.add('cancelTrade')
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
    if (s.pendingJail) {
      out.add('goToJail')
    } else if (s.pendingCardDraw) {
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

// What single decision is currently blocking play, if any: WHO it belongs
// to and WHAT kind it is. Pure on the state — the ONE source of truth for
// both the view projection (HostView.waitingOn, built here at view time)
// and the server's decision clock (rooms.ts decisionFor delegates to
// this). The key strings are load-bearing: the room layer's auto-play
// table matches their prefixes, so a format change is a behaviour change —
// the remedy checks pin them.
//
// Semantics (byte-identical to the room-local logic this replaced):
//   ROLL    → the current player's roll attempt (kind 'roll', even from
//             jail — the owed decision there is still the roll; the
//             separate 'jail' kind is the two-step arrest tap below)
//   ACTION  → pendingJail → the arrest tap ('jail', owned by the arrested
//             player), else pendingCardDraw ('draw'), pendingPurchase
//             ('buy'), pendingTax ('tax'), else the end-of-turn wait ('end')
//   DEBT    → the debtor's payment ('debt')
//   AUCTION → the whole table ('auc', playerId null — auctions wait on
//             everyone, which is exactly why deadlineFor's null overload
//             can't serve this role)
export function blockingDecision(s: GameState): WaitingOn | null {
  if (s.phase === 'ROLL') {
    // dice+doubles in the key so a doubles bonus roll gets a fresh identity
    const d = s.dice ? `${s.dice[0] + s.dice[1]}` : '0'
    return { key: `roll:${s.turn}:${s.currentPlayerId}:${d}:${s.doubles}`, playerId: s.currentPlayerId, kind: 'roll' }
  }
  if (s.phase === 'ACTION') {
    if (s.pendingJail) return { key: `jail:${s.turn}:${s.pendingJail.player}`, playerId: s.pendingJail.player, kind: 'jail' }
    if (s.pendingCardDraw) return { key: `draw:${s.turn}:${s.pendingCardDraw.deck}:${s.pendingCardDraw.space}`, playerId: s.currentPlayerId, kind: 'draw' }
    if (s.pendingPurchase != null) return { key: `buy:${s.turn}:${s.pendingPurchase}`, playerId: s.currentPlayerId, kind: 'buy' }
    if (s.pendingTax) return { key: `tax:${s.turn}`, playerId: s.currentPlayerId, kind: 'tax' }
    return { key: `end:${s.turn}:${s.currentPlayerId}`, playerId: s.currentPlayerId, kind: 'end' }
  }
  if (s.phase === 'DEBT' && s.debt) {
    const d = s.debt
    // debtor AND creditor AND amount AND queue-depth in the key: a same-debtor
    // relay (chairman paying each player) reuses one debtor+turn — with only
    // those fields every relay row looked like the SAME decision.
    return {
      key: `debt:${s.turn}:${d.debtor}:${d.creditor ?? 'bank'}:${d.amount}:${s.debtQueue.length}`,
      playerId: d.debtor,
      kind: 'debt',
    }
  }
  if (s.phase === 'AUCTION' && s.auction) {
    // The bid and bidder are in the key so every new bid is a fresh decision
    // — the hammer falls only after real silence, never mid-bidding-war.
    return { key: `auc:${s.turn}:${s.auction.space}:${s.auction.bid}:${s.auction.bidder ?? '-'}`, playerId: null, kind: 'auc' }
  }
  return null
}
