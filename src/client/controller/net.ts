// ── Connection lifecycle ──
// The socket singleton, the update pill, the rejoin-on-reconnect path and
// the two emit helpers every other module speaks through. The push
// reactions that span the render/sheet/overlay layers (lobby, view,
// room:closed, kicked) are registered by main.ts, the composition root.

import { io } from 'socket.io-client'
import { startUpdater } from '../version-check.js'
import type { Action } from '../../shared/types.js'
import { getMyPlayerId, getMyToken, setMyPlayerId, setMyToken, setRejoinPending } from './state.js'
import { toast } from './shared.js'
import { render } from './screens.js'

export interface JoinAck {
  ok: boolean
  code?: string
  playerId?: string
  token?: string
  error?: string
}
export interface RejoinAck {
  ok: boolean
  code?: string
  playerId?: string
  error?: string
}

// Fires on the FIRST connect and on every automatic reconnect (Wi-Fi blip,
// screen lock, server restart). The stored token reattaches the seat —
// wallet, deeds and jail cards intact. This is the seamless-rejoin path.
export const socket = io()
// update detection: pockets hold stale tabs for hours — prompt when the
// server moves on (reload is safe: the rejoin token restores the seat)
startUpdater({
  socket,
  title: 'Update ready',
  note: 'Tap Refresh — you keep your seat and your cash.',
  button: 'Refresh',
})

socket.on('connect', () => {
  const token = getMyToken()
  if (!token) return
  setRejoinPending(true)
  socket.emit('room:rejoin', { token }, (res: RejoinAck) => {
    if (res.ok) {
      setMyPlayerId(res.playerId ?? getMyPlayerId())
      localStorage.setItem('mp-playerid', getMyPlayerId() ?? '')
    } else {
      localStorage.removeItem('mp-token')
      localStorage.removeItem('mp-playerid')
      setMyToken(null)
      setMyPlayerId(null)
    }
    setRejoinPending(false)
    render()
  })
})

// A dead socket silently queues emits forever — every player-initiated
// send must say so instead of swallowing the tap.
export function ensureConnected(): boolean {
  if (socket.connected) return true
  toast('Reconnecting — hang on a sec')
  return false
}

export function send(a: Action): void {
  if (!ensureConnected()) return
  socket.emit('game:action', a, (res: { ok: boolean; error?: string }) => {
    if (!res.ok) toast(res.error ?? 'Not allowed right now')
  })
}
