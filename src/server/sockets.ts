// ── Socket wiring ──
// attach() is the composition point: it records the io server, points the
// snapshot layer at its directory and boots the restore, then registers
// the one connection handler — per-socket rate limiting, the safe()
// registrar, the event surface (lobby lifecycle lives in lobby.ts, the
// god console in god.ts, the game-action ingress below), the disconnect
// bookkeeping and the idle-room cleanup.

import type { Server as IOServer, Socket } from 'socket.io'
import { validAction } from '../shared/validate.js'
import {
  EMPTY_ROOM_TTL_MS,
  RATE_CAPACITY,
  RATE_EXHAUSTION_MS,
  RATE_REFILL_PER_SEC,
  ROOM_TTL_MS,
  isCurrentConnection,
  playerTokens,
  promoteHostOnDisconnect,
  rooms,
  safe,
  setIoRef,
  type SocketData,
} from './core.js'
import { broadcast, commit } from './clock.js'
import { loadSnapshots, setSnapDir, unlinkSnapshot } from './persist.js'
import {
  applySettings,
  createRoom,
  handOver,
  hostJoin,
  joinRoom,
  kickFromLobby,
  leaveRoom,
  renameSelf,
  resetRoom,
  setColor,
  setPiece,
  startGame,
  watchRoom,
  rejoinRoom,
} from './lobby.js'
import { handleGodCommand } from './god.js'

export function attach(io: IOServer, getJoinUrls: (code: string) => string[], snapshotDir = 'snapshots'): void {
  setIoRef(io)
  setSnapDir(snapshotDir)
  loadSnapshots()
  io.on('connection', (socket: Socket) => {
    const data = socket.data as SocketData
    socket.onAny(() => {
      const room = data.code ? rooms.get(data.code) : undefined
      if (room) room.lastActive = Date.now()
    })

    // Register a handler that can never take the process down: safe() turns
    // any throw into a logged error plus a {ok:false} ack. The ack is
    // whichever argument arrived as a function — most events are
    // (payload, ack), a few are (ack) only.
    //
    // Every inbound event first passes this socket's token bucket
    // (capacity 30, refill 10/s). Over-limit events are dropped with an
    // error ack — never silently — and logged with room + socket id; only
    // sustained exhaustion (bucket continuously empty ≥10s) disconnects
    // the socket, which is auto-rejoinable: the seat waits.
    const bucket = { tokens: RATE_CAPACITY, at: Date.now(), emptySince: null as number | null, dropped: 0 }
    const rateTake = (ack?: (res: unknown) => void): boolean => {
      const now = Date.now()
      bucket.tokens = Math.min(RATE_CAPACITY, bucket.tokens + ((now - bucket.at) / 1000) * RATE_REFILL_PER_SEC)
      bucket.at = now
      if (bucket.tokens < 1) {
        if (bucket.emptySince == null) bucket.emptySince = now
        if (now - bucket.emptySince >= RATE_EXHAUSTION_MS) {
          console.error(`[rate] room ${data.code ?? '-'} socket ${socket.id}: sustained exhaustion — disconnecting (${bucket.dropped} dropped)`)
          ack?.({ ok: false, error: 'Slow down — you are sending too fast' })
          socket.disconnect(true)
          return false
        }
        // Never silent to the CLIENT (error ack always goes out), but the
        // journal only sees the first drops and then a heartbeat — a flood
        // must not turn the log into its second victim.
        bucket.dropped++
        if (bucket.dropped <= 5 || bucket.dropped % 100 === 0) {
          console.error(`[rate] room ${data.code ?? '-'} socket ${socket.id}: event dropped (rate limit) (${bucket.dropped})`)
        }
        ack?.({ ok: false, error: 'Slow down — you are sending too fast' })
        return false
      }
      bucket.tokens -= 1
      // Only a serve from a mostly-refilled bucket clears the exhaustion
      // clock — the client genuinely stopped hammering. A lucky 1-token
      // refill mid-flood (batched arrivals) must never reset it.
      if (bucket.tokens >= RATE_CAPACITY / 2) {
        bucket.emptySince = null
        bucket.dropped = 0
      }
      return true
    }
    const on = (ev: string, handler: (raw: unknown, ack?: (res: unknown) => void) => void): void => {
      socket.on(ev, (...args: unknown[]) => {
        const ack = args.find((a): a is (res: unknown) => void => typeof a === 'function')
        if (!rateTake(ack)) return
        safe(ev, ack, () => handler(args[0], ack))
      })
    }

    // ── TV ──
    on('room:create', (_raw: unknown, ack?: (res: unknown) => void) => createRoom(io, socket, data, ack, getJoinUrls))
    on('room:hostJoin', (raw: unknown, ack?: (res: unknown) => void) => hostJoin(io, socket, data, raw, ack, getJoinUrls))
    on('room:watch', (raw: unknown, ack?: (res: unknown) => void) => watchRoom(io, socket, data, raw, ack, getJoinUrls))

    // ── Phones ──
    on('room:join', (raw: unknown, ack?: (res: unknown) => void) => joinRoom(io, socket, data, raw, ack))
    on('room:rejoin', (raw: unknown, ack?: (res: unknown) => void) => rejoinRoom(io, socket, data, raw, ack))
    on('room:leave', (_raw: unknown, ack?: (res: unknown) => void) => leaveRoom(io, socket, data, ack))
    on('room:setPiece', (raw: unknown, ack?: (res: unknown) => void) => setPiece(io, socket, data, raw, ack))
    on('room:setColor', (raw: unknown, ack?: (res: unknown) => void) => setColor(io, socket, data, raw, ack))
    on('room:rename', (raw: unknown, ack?: (res: unknown) => void) => renameSelf(io, socket, data, raw, ack))
    on('room:kick', (raw: unknown, ack?: (res: unknown) => void) => kickFromLobby(io, socket, data, raw, ack))

    // ── Party host powers ──
    on('game:handOver', (raw: unknown, ack?: (res: unknown) => void) => handOver(io, socket, data, raw, ack))
    on('room:reset', (_raw: unknown, ack?: (res: unknown) => void) => resetRoom(io, socket, data, ack, getJoinUrls))

    // ── Game flow ──
    on('game:start', (_raw: unknown, ack?: (res: unknown) => void) => startGame(io, socket, data, ack))

    on('game:action', (raw: unknown, ack?: (res: unknown) => void) => {
      // The engine is I/O-free and trusts its inputs; the boundary check
      // here is what makes that safe. Nothing malformed reaches applyAction.
      const action = validAction(raw)
      if (!action) return ack?.({ ok: false, error: 'Malformed action' })
      const room = data.code ? rooms.get(data.code) : undefined
      if (!room?.state) return ack?.({ ok: false, error: 'No game running' })
      if (!isCurrentConnection(room, data, socket.id) || !data.playerId) {
        return ack?.({ ok: false, error: 'Players only' })
      }

      // Clone, apply, and only commit on success — a failed action never
      // leaves half-applied state behind. The gate asks the engine's own
      // allowed list BEFORE any clone (an illegal socket action costs no
      // state copy); the reducer still enforces legality behind it, so the
      // phone sees byte-identical rejections either way.
      room.lastActive = Date.now()
      const res = commit(room, io, data.playerId, action, { gate: true })
      if (!res.ok) return ack?.({ ok: false, error: res.error })

      ack?.({ ok: true })
    })

    // ── Host lobby settings ──
    on('room:settings', (raw: unknown, ack?: (res: unknown) => void) => applySettings(io, socket, data, raw, ack))

    // ── God console (TV hosts only) ──
    on('god:command', (raw: unknown, ack?: (res: unknown) => void) => handleGodCommand(io, socket, data, raw, ack))

    socket.on('disconnect', () => {
      safe('disconnect', undefined, () => {
        const room = data.code ? rooms.get(data.code) : undefined
        if (!room) return
        if (data.role === 'host') room.hostSockets.delete(socket.id)
        if (data.role === 'player') {
          const e = room.players.find((x) => x.meta.id === data.playerId)
          // Only the player's CURRENT connection counts: a stale socket
          // dying long after the phone already reconnected (socket.io
          // notices ~45s later) must not touch the seat or steal the crown.
          const wasCurrent = e != null && e.socketId === socket.id
          if (wasCurrent) {
            e.socketId = null
            e.disconnectedAt = Date.now()
          }
          // The party crown never goes dark: hand it down the queue.
          if (wasCurrent && data.playerId === room.hostPlayerId) promoteHostOnDisconnect(room)
        }
        broadcast(room, io)
      })
    })
  })

  // Idle-room cleanup so a night of partying doesn't leak memory. Empty
  // rooms die fast (10 min) as long as no TV is watching them; real rooms
  // keep the 3-hour TTL measured from the last HUMAN action.
  setInterval(() => {
    safe('idle-room cleanup', undefined, () => {
      const now = Date.now()
      for (const [code, room] of rooms) {
        const emptyJunk = room.hostSockets.size === 0 && room.players.length === 0 && !room.state
        const expired = now - room.lastActive > (emptyJunk ? EMPTY_ROOM_TTL_MS : ROOM_TTL_MS)
        if (expired && room.hostSockets.size === 0) {
          rooms.delete(code)
          for (const [tok, ref] of playerTokens) if (ref.code === code) playerTokens.delete(tok)
          unlinkSnapshot(code)
        }
      }
    })
  }, 5 * 60 * 1000).unref?.()
}
