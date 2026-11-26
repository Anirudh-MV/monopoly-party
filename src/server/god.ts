// ── God console ──
// Emergency operator controls for the TV host: rescue turns, edit wallets,
// reassign properties, force reveals, export/import the whole game. The
// handler body is the verbatim pre-split switch; sockets.ts registers it
// on 'god:command' behind the same hostSockets gate.

import type { Server as IOServer, Socket } from 'socket.io'
import { MAX_GAME_LOG, nextPlayer } from '../shared/engine.js'
import { validGodCommand } from '../shared/validate.js'
import type { GameState } from '../shared/types.js'
import {
  playerRoom,
  playerTokens,
  promoteHostOnDisconnect,
  rooms,
  type Room,
  type SocketData,
} from './core.js'
import { broadcastGame, broadcastLobby, commit, forfeitSeat } from './clock.js'
import { restoreRoomFromSnapshot, saveRoom, serializeRoom, validateSnapshot } from './persist.js'

const MAX_LOG = MAX_GAME_LOG

function godLog(next: GameState, note: string): void {
  next.log.push({ text: `GOD: ${note}`, kind: 'info' })
  if (next.log.length > MAX_LOG) next.log.splice(0, next.log.length - MAX_LOG)
}

export function godMutate(io: IOServer, room: Room, note: string, fn: (s: GameState) => void): boolean {
  // The tamper-proof TV console: clone, mutate, log, commit — the same one
  // commit path everything else uses (ungated by design: god is trusted).
  return commit(room, io, '', (n: GameState) => {
    fn(n)
    godLog(n, note)
  }).ok
}

export function handleGodCommand(
  io: IOServer,
  socket: Socket,
  data: SocketData,
  raw: unknown,
  ack?: (res: unknown) => void,
): void {
  const room = data.code ? rooms.get(data.code) : undefined
  if (!room || !room.hostSockets.has(socket.id)) {
    return ack?.({ ok: false, error: 'The god console is only available on the TV screen' })
  }
  // God payloads are validated like everything else — a hostile or
  // half-broken TV browser must not write NaN into the state either.
  const payload = validGodCommand(raw)
  if (!payload) return ack?.({ ok: false, error: 'Unknown god command' })
  const s = room.state

  switch (payload.cmd) {
    case 'skipTurn': {
      if (!s) return ack?.({ ok: false, error: 'No game running' })
      const skipped = s.players.find((p) => p.id === s.currentPlayerId)?.name ?? 'the current player'
      godMutate(io, room, `skipped ${skipped}'s turn`, (n) => {
        n.pendingPurchase = null
        n.pendingTax = null
        n.pendingCardDraw = null
        n.pendingCard = null
        n.pendingMove = null
        n.debt = null
        n.debtQueue = []
        n.auction = null
        n.auctionQueue = []
        n.dice = null
        n.doubles = 0
        // advance through the engine's own boundary — nextPlayer checks
        // the round cap before moving, so a god skip can never smuggle
        // the game past its own cap
        nextPlayer(n)
      })
      return ack?.({ ok: true })
    }

    case 'replayTurn': {
      if (!s) return ack?.({ ok: false, error: 'No game running' })
      const target = payload.playerId ?? s.currentPlayerId
      const name = s.players.find((p) => p.id === target)?.name ?? '?'
      godMutate(io, room, `handed the turn back to ${name}`, (n) => {
        n.currentPlayerId = target
        n.phase = 'ROLL'
        n.dice = null
        n.doubles = 0
        n.pendingPurchase = null
        n.pendingTax = null
        n.pendingCardDraw = null
        n.pendingMove = null
        n.debt = null
        n.debtQueue = []
        n.auction = null
        n.auctionQueue = []
      })
      return ack?.({ ok: true })
    }

    case 'setCash': {
      if (!s) return ack?.({ ok: false, error: 'No game running' })
      const amount = Math.max(0, Math.floor(Number(payload.amount)))
      const name = s.players.find((p) => p.id === payload.playerId)?.name ?? '?'
      godMutate(io, room, `set ${name}'s cash to $${amount}`, (n) => {
        const p = n.players.find((q) => q.id === payload.playerId)
        if (p) p.cash = amount
      })
      return ack?.({ ok: true })
    }

    case 'setPos': {
      if (!s) return ack?.({ ok: false, error: 'No game running' })
      const pos = Math.max(0, Math.min(39, Math.floor(Number(payload.pos))))
      const name = s.players.find((p) => p.id === payload.playerId)?.name ?? '?'
      godMutate(io, room, `moved ${name} to ${pos === 10 && payload.jail ? 'jail' : `space ${pos}`}`, (n) => {
        const p = n.players.find((q) => q.id === payload.playerId)
        if (p) {
          p.pos = pos
          if (payload.jail !== undefined) {
            p.jail = payload.jail
            if (payload.jail) p.jailRolls = 0
          }
        }
      })
      return ack?.({ ok: true })
    }

    case 'setJail': {
      if (!s) return ack?.({ ok: false, error: 'No game running' })
      const name = s.players.find((p) => p.id === payload.playerId)?.name ?? '?'
      godMutate(io, room, `${payload.jail ? 'jailed' : 'released'} ${name}`, (n) => {
        const p = n.players.find((q) => q.id === payload.playerId)
        if (p) {
          p.jail = payload.jail
          if (payload.jail) {
            p.pos = 10
            p.jailRolls = 0
          }
        }
      })
      return ack?.({ ok: true })
    }

    case 'setJailCards': {
      if (!s) return ack?.({ ok: false, error: 'No game running' })
      const count = Math.max(0, Math.min(5, Math.floor(Number(payload.count))))
      const name = s.players.find((p) => p.id === payload.playerId)?.name ?? '?'
      godMutate(io, room, `set ${name}'s jail cards to ${count}`, (n) => {
        const p = n.players.find((q) => q.id === payload.playerId)
        if (p) p.jailCards = count
      })
      return ack?.({ ok: true })
    }

    case 'setProperty': {
      if (!s) return ack?.({ ok: false, error: 'No game running' })
      const st = s.props[payload.space]
      if (!st) return ack?.({ ok: false, error: 'Not a purchasable space' })
      const ownerName = payload.owner ? (s.players.find((p) => p.id === payload.owner)?.name ?? 'a player') : 'the bank'
      godMutate(io, room, `gave space ${payload.space} to ${ownerName}`, (n) => {
        const t = n.props[payload.space]
        if (t) t.owner = payload.owner
      })
      return ack?.({ ok: true })
    }

    case 'setHouses': {
      if (!s) return ack?.({ ok: false, error: 'No game running' })
      const st = s.props[payload.space]
      if (!st) return ack?.({ ok: false, error: 'Not a street' })
      const count = Math.max(0, Math.min(5, Math.floor(Number(payload.count))))
      godMutate(io, room, `set space ${payload.space} to ${count === 5 ? 'hotel' : `${count} house(s)`}`, (n) => {
        const t = n.props[payload.space]
        if (t) t.houses = count
      })
      return ack?.({ ok: true })
    }

    case 'setMortgaged': {
      if (!s) return ack?.({ ok: false, error: 'No game running' })
      const st = s.props[payload.space]
      if (!st) return ack?.({ ok: false, error: 'Not a purchasable space' })
      godMutate(io, room, `${payload.mortgaged ? 'mortgaged' : 'lifted the mortgage on'} space ${payload.space}`, (n) => {
        const t = n.props[payload.space]
        if (t) t.mortgaged = payload.mortgaged
      })
      return ack?.({ ok: true })
    }

    case 'forceDraw': {
      if (!s) return ack?.({ ok: false, error: 'No game running' })
      // A pending debt or arrest owns the table until it settles —
      // forcing a draw on top of either would leave a reveal nobody is
      // allowed to open.
      if (s.debt) return ack?.({ ok: false, error: 'A debt is pending — it must settle first' })
      if (s.pendingJail) return ack?.({ ok: false, error: 'An arrest is pending — it must resolve first' })
      const name = s.players.find((p) => p.id === s.currentPlayerId)?.name ?? '?'
      godMutate(io, room, `forced a ${payload.deck === 'chest' ? 'Community Chest' : 'Chance'} draw for ${name}`, (n) => {
        n.pendingPurchase = null
        n.pendingTax = null
        const cur = n.players.find((q) => q.id === n.currentPlayerId)
        n.pendingCardDraw = cur
          ? { player: cur.id, deck: payload.deck, space: cur.pos }
          : null
        n.phase = 'ACTION'
      })
      return ack?.({ ok: true })
    }

    case 'setTimer': {
      const raw = Math.floor(Number(payload.ms))
      const ms = Number.isFinite(raw) ? Math.max(0, Math.min(3_600_000, raw)) : room.turnTimeoutMs
      room.turnTimeoutMs = ms
      // The in-progress decision re-arms with the new duration.
      room.timerKey = null
      if (s) {
        godMutate(io, room, `decision timer ${ms === 0 ? 'disabled' : `set to ${Math.round(ms / 1000)}s`}`, () => {})
      } else {
        broadcastLobby(io, room)
        void saveRoom(room)
      }
      return ack?.({ ok: true })
    }

    case 'endGame': {
      if (!s) return ack?.({ ok: false, error: 'No game running' })
      const winner = payload.winner
        ? (s.players.find((p) => p.id === payload.winner)?.name ?? 'nobody')
        : (s.players.find((p) => p.id === s.winner)?.name ?? 'nobody')
      godMutate(io, room, `ended the game — ${winner} wins`, (n) => {
        const w = payload.winner ?? n.winner
        n.phase = 'GAME_OVER'
        n.winner = w
        // keep the pair consistent: winner === winners[0] ?? null
        n.winners = w != null ? [w] : []
        n.pendingPurchase = null
        n.pendingTax = null
        n.pendingCardDraw = null
        n.debt = null
        n.debtQueue = []
        n.auction = null
        n.auctionQueue = []
      })
      return ack?.({ ok: true })
    }

    case 'kick': {
      if (!s) return ack?.({ ok: false, error: 'No game running' })
      if (s.phase === 'GAME_OVER') return ack?.({ ok: false, error: 'The game is already over' })
      const target = s.players.find((q) => q.id === payload.playerId)
      if (!target) return ack?.({ ok: false, error: 'Not in this game' })
      if (target.bankrupt) return ack?.({ ok: false, error: 'They are already out' })
      // Same estate rule as a voluntary exit: player-debt → the lender
      // inherits via declareBankruptcy; anything else → bank forfeit
      // with the deeds under the hammer. forfeitSeat logs the headline.
      // Commit without broadcast first — the eviction below lands
      // before the one broadcast ships the new state.
      const res = commit(
        room,
        io,
        payload.playerId,
        (n) => forfeitSeat(n, payload.playerId, `The host removed ${target.name} — their properties go under the hammer`),
        { broadcast: false },
      )
      if (!res.ok) return ack?.({ ok: false, error: res.error })
      // Evict the phone exactly like the lobby kick: identity dies
      // with the seat, the rejoin token is destroyed.
      const entry = room.players.find((e) => e.meta.id === payload.playerId)
      if (entry) {
        playerTokens.delete(entry.token)
        const kicked = entry.socketId != null ? io.sockets.sockets.get(entry.socketId) : undefined
        if (kicked) {
          const td = kicked.data as SocketData
          if (td.code === room.code && td.playerId === payload.playerId) {
            td.code = undefined
            td.role = undefined
            td.playerId = undefined
          }
          kicked.leave(playerRoom(room.code, payload.playerId))
          kicked.emit('kicked')
        }
        entry.socketId = null
        entry.disconnectedAt = Date.now()
        if (room.hostPlayerId === payload.playerId) promoteHostOnDisconnect(room)
      }
      broadcastGame(io, room)
      return ack?.({ ok: true })
    }

    case 'export': {
      return ack?.({ ok: true, snapshot: serializeRoom(room) })
    }

    case 'import': {
      // Validate the ENTIRE snapshot first — the room is only touched if
      // every field is known-safe (see validateSnapshot).
      const snap = validateSnapshot(payload.json)
      if (!snap) {
        return ack?.({ ok: false, error: 'That file is not a valid game snapshot' })
      }
      restoreRoomFromSnapshot(room, snap)
      if (room.state) {
        godLog(room.state, 'imported a game snapshot')
        broadcastGame(io, room)
      } else {
        broadcastLobby(io, room)
        void saveRoom(room)
      }
      return ack?.({ ok: true })
    }

    default:
      return ack?.({ ok: false, error: 'Unknown god command' })
  }
}
