import { allowedActions } from './rules.js'
import type { GameState, HostView, PlayerView } from './types.js'

// Monopoly is full-information, so the projection is mostly a trim:
// the TV gets everything public; phones additionally get their own
// allowed-actions list and the trade offers they're party to.

export function hostView(s: GameState, code: string, hostId: string | null, turnTimeoutMs: number): HostView {
  return {
    code,
    phase: s.phase,
    started: s.phase !== 'LOBBY',
    turn: s.turn,
    currentPlayerId: s.currentPlayerId,
    hostId,
    players: s.players,
    props: s.props,
    dice: s.dice,
    log: s.log.slice(-40),
    ledger: s.ledger.slice(-150),
    auction: s.auction,
    pendingCard: s.pendingCard,
    pendingCardDraw: s.pendingCardDraw,
    cardDrawSeq: s.cardDrawSeq,
    pendingJail: s.pendingJail,
    pendingPurchase: s.pendingPurchase,
    pendingTax: s.pendingTax,
    debt: s.debt,
    winner: s.winner,
    trades: s.trades,
    lastLanded: s.lastLanded,
    lastMove: s.lastMove,
    deadline: s.deadline,
    deadlineFor: s.deadlineFor,
    turnTimeoutMs,
  }
}

export function playerView(s: GameState, code: string, pid: string, hostId: string | null, turnTimeoutMs: number): PlayerView {
  const base = hostView(s, code, hostId, turnTimeoutMs)
  return {
    ...base,
    you: pid,
    allowed: allowedActions(s, pid),
    trades: s.trades.filter((t) => t.from === pid || t.to === pid),
    isHost: hostId === pid,
  }
}
