// ── Phone controller ──
// Your wallet, your properties, your decisions — plus the full transaction
// ledger for every player. The server tells us what we're allowed to do
// (PlayerView.allowed) and the shared rules helpers give per-property
// affordances. Card spaces are interactive: open the chest / spin the wheel,
// and the reveal animates here and on the TV.
//
// This file is the composition root: it registers the socket-push
// reactions and the delegated event surface — each exactly once — and
// paints the first screen. The layers live in the sibling modules:
//   shared.ts   — DOM roots + pure helpers (esc/avathumb, deed affordances)
//   state.ts    — the mutable phone state + the roll state machine
//   net.ts      — the socket, reconnection, the emit/ack helpers
//   screens.ts  — the join/lobby/game render flow ($app rebuilds)
//   sheets.ts   — the chrome patcher: sheets, the dock, the your-move bar
//   overlays.ts — the body-level momentary covers (board, dice, confirms)
//   actions.ts  — the delegated data-act command switch

import type { LobbyInfo, PlayerView } from '../../shared/types.js'
import { socket } from './net.js'
import {
  freezeEffectLine,
  getFrozenEffectLine,
  getLastCardSeq,
  getMyName,
  getPopGuard,
  getSheet,
  getView,
  setComposer,
  setDeedFilters,
  setJoinCode,
  setJoinName,
  setJoinStage,
  setLastCardSeq,
  setLobby,
  setLobbySel,
  setMyPlayerId,
  setMyToken,
  setPopGuard,
  setRejoinPending,
  setView,
} from './state.js'
import { $app, $chrome, toast } from './shared.js'
import { render } from './screens.js'
import { closeSheet, SHEET_IDS } from './sheets.js'
import {
  closeBoard,
  isBoardOpen,
  markFirstViewSeen,
  maybeDing,
  maybeShowGoPrompt,
  maybeShowRoll,
  showReveal,
  syncBoard,
} from './overlays.js'
import { onActionClick, onComposerInput, resetScreenStates } from './actions.js'

// ── The delegated event surface ──
// One click handler serves BOTH roots: $app (the rebuilt main flow) and
// $chrome (the patch-managed sheets) are siblings, so a tap inside a sheet
// never bubbles through $app's listener — the same handler is registered
// on each root, exactly once.
$app.addEventListener('click', onActionClick)
$chrome.addEventListener('click', onActionClick)

// The composer's cash inputs live in #chrome now; the same delegated
// input handler covers both roots. Writes only the composer STATE — the
// input element itself is never touched by a patch (focus/contents ride).
$app.addEventListener('input', onComposerInput)
$chrome.addEventListener('input', onComposerInput)

// Android back / browser back: the popstate is either our own pop (the
// cover is already closed — stand down) or the user's (close, exactly
// once). Two cover kinds, one handler: whichever entry the history just
// popped names the cover that dies — a board entry never eats a sheet's
// back and vice versa.
window.addEventListener('popstate', (ev) => {
  if (getPopGuard()) {
    setPopGuard(false)
    return
  }
  const st = ev.state as { mpSheet?: string; mpBoard?: number } | null
  if (isBoardOpen() && !st?.mpBoard) {
    closeBoard()
    return
  }
  if (getSheet() && !st?.mpSheet) closeSheet()
})

// Dialog keyboard semantics: Escape closes (one path — closeSheet), and
// Tab / Shift-Tab cycle within the open sheet. The dock sits ABOVE sheets
// but outside the cycle: the sheet is the dialog, the dock is furniture.
// A body-level overlay stacked above (confirm, reveal, propinfo, the
// roller, the board) owns the screen instead — Escape stands down.
document.addEventListener('keydown', (ev) => {
  const sheet = getSheet()
  if (!sheet) return
  if (document.querySelector('.confirm-overlay, .reveal-overlay, .propinfo-overlay, .roll-overlay, .board-overlay')) return
  if (ev.key === 'Escape') {
    closeSheet()
    return
  }
  if (ev.key !== 'Tab') return
  const el = document.getElementById(SHEET_IDS[sheet])
  if (!el) return
  const focusables = [...el.querySelectorAll<HTMLElement>('button:not([disabled]), input, select, textarea, [href]')].filter(
    (n) => n.offsetParent != null,
  )
  if (focusables.length === 0) return
  const first = focusables[0]!
  const last = focusables[focusables.length - 1]!
  const active = document.activeElement as HTMLElement | null
  if (ev.shiftKey && (!el.contains(active) || active === first)) {
    ev.preventDefault()
    last.focus()
  } else if (!ev.shiftKey && (!el.contains(active) || active === last)) {
    ev.preventDefault()
    first.focus()
  }
})

// ── Socket-push reactions ──

socket.on('lobby', (l: LobbyInfo) => {
  setLobby(l)
  setView(null)
  setRejoinPending(false)
  // screen transition: the game-only sheets die with the game view
  if (getSheet()) closeSheet()
  render()
})

// The party host dissolved the room and minted a fresh one — land on the
// join screen with the new code (and your name) prefilled; no auto-rejoin,
// the seat assignment is yours to remake.
socket.on('room:closed', (p: { code?: string }) => {
  const code = p.code ?? ''
  const name = getMyName()
  localStorage.removeItem('mp-token')
  localStorage.removeItem('mp-playerid')
  setMyToken(null)
  setMyPlayerId(null)
  setLobby(null)
  setView(null)
  setComposer(null)
  setLobbySel(null)
  resetScreenStates()
  setJoinStage('name')
  if (/^[A-Z]{4}$/.test(code)) setJoinCode(code)
  if (name) setJoinName(name)
  render()
  toast('This room was closed — join the new room')
})

// The host removed this seat — back to the join screen, politely. Mid-game
// removals are estate forfeits (a different message); lobby kicks are just
// seat removals.
socket.on('kicked', () => {
  const midGame = getView() != null
  localStorage.removeItem('mp-token')
  localStorage.removeItem('mp-playerid')
  setMyToken(null)
  setMyPlayerId(null)
  setLobby(null)
  setView(null)
  setComposer(null)
  setLobbySel(null)
  resetScreenStates()
  render()
  toast(midGame ? 'The host removed you from the game' : 'The host removed you from the room')
})

socket.on('view', (v: PlayerView) => {
  const enteringGame = getView() == null
  setView(v)
  setLobby(null)
  setRejoinPending(false)
  // entering the game from the lobby/join screen: sheets start closed;
  // view pushes DURING the game keep whichever sheet is open, patched
  if (enteringGame) {
    if (getSheet()) closeSheet()
    setDeedFilters({ owner: 'ALL', kind: 'ALL' })
  }

  // freeze the effect line at draw time (repairs totals and pay-each
  // counts must never drift mid-reveal), then reveal on the drawer's phone
  freezeEffectLine(v)
  if (v.cardDrawSeq > getLastCardSeq() && getLastCardSeq() >= 0 && v.pendingCard && v.currentPlayerId === v.you) {
    showReveal(v.pendingCard, getFrozenEffectLine() || undefined)
  }
  setLastCardSeq(v.cardDrawSeq)

  render()
  maybeShowRoll(v)
  maybeShowGoPrompt(v)
  maybeDing(v)
  markFirstViewSeen()
  // a roaming board stays live with the game
  syncBoard(v)
})

// First paint: never leave the phone blank while the socket warms up.
render()
