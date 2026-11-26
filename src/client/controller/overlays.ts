// ── Overlays: the body-level momentary covers ──
// The pocket board, the property info card, the confirm family (exit,
// action, reset, the rename editor), the card reveal, the dice roll
// moment (strip + overlay), the GO salary prompt, the attention ding and
// the board sync hook. Every one of these mounts straight on
// document.body — untouched by both $app rebuilds and the chrome patcher.

import { stripEmoji } from '../../shared/tokens.js'
import { Board3D } from '../host/board3d.js'
import { cardFace, deedFull } from '../deed-card.js'
import type { Card, PlayerView } from '../../shared/types.js'
import {
  getDiceStrip,
  getDingOn,
  getLobby,
  getPhoneBoard,
  getPopGuard,
  getTheme,
  getView,
  maybeConsumeRoll,
  setDiceStrip,
  setMyName,
  setPhoneBoard,
  setPopGuard,
} from './state.js'
import { $app, avathumb, esc, toast } from './shared.js'
import { ensureConnected, socket } from './net.js'
import { render } from './screens.js'

// ── card reveal overlay (chest opens / wheel spins) ──

export function showReveal(card: Card, effectLine?: string): void {
  const isChest = card.deck === 'chest'
  const overlay = document.createElement('div')
  overlay.className = 'reveal-overlay'
  overlay.innerHTML = `
    <div class="reveal-box">
      ${isChest
        ? '<div class="chestwrap"><div class="chestlid"></div><div class="chestlock"></div><div class="chestbase"></div></div>'
        : '<div class="wheelwrap"><div class="wheeldisc"></div><div class="wheelhub"></div><div class="wheelpointer"></div></div>'}
      <div class="revealcard ${isChest ? 'chest-card' : 'chance-card'}">${cardFace(card, effectLine)}</div>
    </div>`
  const dismiss = (): void => overlay.remove()
  overlay.addEventListener('click', dismiss)
  document.body.appendChild(overlay)
  setTimeout(dismiss, isChest ? 3200 : 4200)
}

// ── two-step exit confirmation ──
// Leaving is the one destructive thing a phone can do to itself: mid-game
// it's an immediate forfeit — the estate goes under the hammer, the game
// plays on, and this phone can never rejoin. So it takes TWO separate
// confirmations, with different wording each step so neither can be
// muscle-memoryed. The final step's resolution is passed in by the
// caller (actions.ts's performExit) — the overlay itself stays free of
// the leave logic.
export function showExitConfirm(step: 1 | 2, onFinal: () => void): void {
  document.querySelector('.confirm-overlay')?.remove()
  const inGame = getView() != null
  const overlay = document.createElement('div')
  overlay.className = 'confirm-overlay'
  overlay.dataset.step = String(step)
  overlay.innerHTML = `
    <div class="confirm-box">
      <div class="confirm-title">${step === 1 ? 'Leave this game?' : 'Last chance'}</div>
      <p class="confirm-body">${
        step === 1
          ? inGame
            ? 'You\u2019ll go back to the join screen and can enter a different room code. Your estate will be auctioned off and the game goes on without you.'
            : 'You\u2019ll go back to the join screen and can enter a different room code.'
          : inGame
            ? 'Really leave? This phone can never rejoin the game you\u2019re in. Your cash and properties go to the bank — the table auctions them off.'
            : 'Really leave the room? This is the final confirmation.'
      }</p>
      <div class="row">
        <button data-act="exitCancel">${step === 1 ? 'Keep playing' : 'Stay'}</button>
        <button class="danger" data-act="exitContinue">${step === 1 ? 'Continue' : 'Yes, leave'}</button>
      </div>
      <p class="hint confirm-step">Confirmation ${step} of 2</p>
    </div>`
  overlay.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('[data-act]') as HTMLElement | null
    if (!btn) {
      // tapped the backdrop — that always means "keep playing"
      if (ev.target === overlay) overlay.remove()
      return
    }
    if (btn.dataset.act === 'exitCancel') overlay.remove()
    else if (btn.dataset.act === 'exitContinue') {
      if (overlay.dataset.step === '1') showExitConfirm(2, onFinal)
      else onFinal()
    }
  })
  document.body.appendChild(overlay)
}

// ── one-step action confirmation ──
// Money moves players regret get exactly one chance to back out.
export function showActionConfirm(title: string, body: string, confirmLabel: string, onConfirm: () => void): void {
  document.querySelector('.confirm-overlay')?.remove()
  const overlay = document.createElement('div')
  overlay.className = 'confirm-overlay'
  overlay.innerHTML = `
    <div class="confirm-box">
      <div class="confirm-title">${title}</div>
      <p class="confirm-body">${body}</p>
      <div class="row">
        <button data-act="aCancel">Not now</button>
        <button class="danger" data-act="aConfirm">${confirmLabel}</button>
      </div>
    </div>`
  overlay.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('[data-act]') as HTMLElement | null
    if (!btn) {
      if (ev.target === overlay) overlay.remove()
      return
    }
    overlay.remove()
    if (btn.dataset.act === 'aConfirm') onConfirm()
  })
  document.body.appendChild(overlay)
}

// ── lobby rename editor ──
// Your own name, lobby only: a small sheet with one prefilled input. A
// refused save (name taken, mid-game, …) keeps the sheet open with the
// server's error visible — nothing is marked, you just try again.
export function showRenameEditor(current: string): void {
  document.querySelector('.confirm-overlay')?.remove()
  const overlay = document.createElement('div')
  overlay.className = 'confirm-overlay'
  overlay.innerHTML = `
    <div class="confirm-box">
      <div class="confirm-title">Your name</div>
      <input id="renameInput" maxlength="16" autocomplete="off" placeholder="e.g. Maya" value="${esc(current)}" />
      <p class="hint" id="renameErr" style="min-height:1.1em; margin-top:8px"></p>
      <div class="row">
        <button data-act="renameCancel">Cancel</button>
        <button class="primary" data-act="renameSave">Save name</button>
      </div>
    </div>`
  const fail = (msg: string): void => {
    toast(msg)
    const err = overlay.querySelector('#renameErr') as HTMLElement | null
    if (err) err.textContent = msg
  }
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) {
      overlay.remove()
      return
    }
    const btn = (ev.target as HTMLElement).closest('[data-act]') as HTMLElement | null
    if (!btn) return
    if (btn.dataset.act === 'renameCancel') {
      overlay.remove()
      return
    }
    if (btn.dataset.act === 'renameSave') {
      const input = overlay.querySelector('#renameInput') as HTMLInputElement | null
      const name = stripEmoji(input?.value ?? '')
      if (!name) return fail('Enter your name (letters and numbers)')
      if (!ensureConnected()) return
      socket.emit('room:rename', { name }, (res: { ok: boolean; error?: string }) => {
        if (res.ok) {
          overlay.remove()
          setMyName(name)
          return
        }
        fail(res.error ?? 'Could not rename')
      })
    }
  })
  document.body.appendChild(overlay)
  const input = overlay.querySelector('#renameInput') as HTMLInputElement | null
  input?.focus()
  input?.select()
}

// ── the dice roll moment ──
// Every phone at the table plays the roll together, in sync with the TV's
// suspense beat — but SPLIT by role since the dock round: the roller keeps
// the full overlay (tap anywhere settles the faces and dismisses — the
// taps lost to the overlay become intentional skips), while everyone else
// gets a small NON-BLOCKING strip under the banner: two mini faces, who
// rolled what, DOUBLES where applicable, gone at the same ~2.6s. No
// countdown on the strip — it is awareness, the your-move bar is pressure
// — and the screen stays fully tappable, so a bid mid-roll must land.
function diceStripHTML(v: PlayerView, until: number): string {
  const roller = v.players.find((p) => p.id === v.currentPlayerId)
  const d1 = v.dice?.[0] ?? 1
  const d2 = v.dice?.[1] ?? 1
  return `<div class="dice-strip" role="status" data-until="${until}">
    <span class="die mini">${pipsFor(d1)}</span><span class="die mini">${pipsFor(d2)}</span>
    <span class="ds-who">${avathumb(roller)}<b>${esc(roller?.name ?? 'Someone')}</b> rolled ${d1 + d2}</span>
    ${d1 === d2 ? '<span class="ds-dbl">DOUBLES!</span>' : ''}
  </div>`
}

function showDiceStrip(v: PlayerView): void {
  const until = Date.now() + 2600
  setDiceStrip({ html: diceStripHTML(v, until), until })
  document.querySelectorAll('.dice-strip').forEach((n) => n.remove())
  $app.querySelector('.banner')?.insertAdjacentHTML('afterend', getDiceStrip()!.html)
  setTimeout(() => {
    document.querySelectorAll('.dice-strip').forEach((n) => {
      if (Number((n as HTMLElement).dataset.until ?? 0) <= Date.now() + 50) n.remove()
    })
    if (getDiceStrip() && Date.now() >= getDiceStrip()!.until) setDiceStrip(null)
  }, 2600)
}

function pipsFor(n: number): string {
  const pos: Record<number, string[]> = {
    1: ['50,50'],
    2: ['28,28', '72,72'],
    3: ['28,28', '50,50', '72,72'],
    4: ['28,28', '72,28', '28,72', '72,72'],
    5: ['28,28', '72,28', '50,50', '28,72', '72,72'],
    6: ['28,28', '72,28', '28,50', '72,50', '28,72', '72,72'],
  }
  return (pos[n] ?? pos[1]!).map((c) => {
    const [x, y] = c.split(',')
    return `<span class="pip" style="left:${x}%;top:${y}%"></span>`
  }).join('')
}

// The roll state machine lives in state.ts; this is only the showing half.
export function maybeShowRoll(v: PlayerView): void {
  if (maybeConsumeRoll(v)) showRollOverlay(v)
}

function showRollOverlay(v: PlayerView): void {
  // the role split happens here, AFTER the gate: bystanders never get the
  // blocking overlay at all
  if (v.currentPlayerId !== v.you) {
    showDiceStrip(v)
    return
  }
  const d1 = v.dice?.[0] ?? 1
  const d2 = v.dice?.[1] ?? 1
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const overlay = document.createElement('div')
  overlay.className = 'roll-overlay'
  overlay.innerHTML = `
    <div class="roll-box mine">
      <div class="roll-who">You roll!</div>
      <div class="dice-row">
        <div class="die tumbling"></div>
        <div class="die tumbling"></div>
      </div>
      <div class="roll-total"></div>
    </div>`
  document.body.appendChild(overlay)
  const [dieA, dieB] = [...overlay.querySelectorAll('.die')] as HTMLElement[]
  const total = overlay.querySelector('.roll-total') as HTMLElement

  let settled = false
  let tumbler: ReturnType<typeof setInterval> | null = null
  const settle = (): void => {
    if (settled) return
    settled = true
    if (tumbler != null) clearInterval(tumbler)
    dieA.innerHTML = pipsFor(d1)
    dieB.innerHTML = pipsFor(d2)
    dieA.classList.remove('tumbling')
    dieB.classList.remove('tumbling')
    dieA.classList.add('settled')
    dieB.classList.add('settled')
    total.textContent = `${d1} + ${d2} = ${d1 + d2}${d1 === d2 ? ' — DOUBLES!' : ''}`
  }

  if (reduced) {
    // reduced motion: no tumbling — the faces settle at once and the
    // overlay is pure awareness, gone at ~600ms
    settle()
    setTimeout(() => overlay.remove(), 600)
    return
  }

  // tumbling faces, swapping fast — the anticipation phase
  tumbler = setInterval(() => {
    dieA.innerHTML = pipsFor(1 + Math.floor(Math.random() * 6))
    dieB.innerHTML = pipsFor(1 + Math.floor(Math.random() * 6))
  }, 90)

  // the TV's dice hold is 1150ms; settle when it does
  setTimeout(settle, 1150)
  // the piece on the TV has (mostly) arrived by now — show the landing
  setTimeout(() => overlay.remove(), 2600)
  // the roller's taps are intentional skips: tap anywhere settles the
  // faces instantly and dismisses
  overlay.addEventListener('click', () => {
    settle()
    setTimeout(() => overlay.remove(), 350)
  })
}

// ── pocket board ──
// The full 3D board on the phone: FREE roaming by default — drag to orbit,
// pinch to zoom, and the view stays exactly where you leave it. Reset
// snaps back to the whole-board overview, Follow re-pins to the action,
// Close returns to the controller. It stays live with the game while open.
// The dock's Board button is the permanent entry point — discovery is
// structural now, no one-time promo needed.
// true while the open board owns its pushed history entry — the sheet
// mechanism mirrored, so Android back over an open board closes the BOARD,
// not the page (and never double-fires with an underlying sheet entry: the
// board's entry sits on top, one back pops exactly one cover).
let boardEntry = false

// Persisted single-finger gesture verb for the pocket board: 'pan' (map-style
// lateral drag, the default) or 'orbit'. Stored per browser.
const GESTURE_FLAG = 'mp-board-gesture'
type GestureMode = 'pan' | 'orbit'
const gestureLabel = (m: GestureMode): string => (m === 'pan' ? '✋ Pan' : '🔄 Orbit')

export function isBoardOpen(): boolean {
  return getPhoneBoard() != null
}

export function showBoard(): void {
  const v = getView()
  if (!v) return
  closeBoard()
  const mode: GestureMode = localStorage.getItem(GESTURE_FLAG) === 'orbit' ? 'orbit' : 'pan'
  const overlay = document.createElement('div')
  overlay.className = 'board-overlay'
  overlay.innerHTML = `
    <div class="board-tools">
      <button class="board-tool" data-act="boardReset">⟲ Reset view</button>
      <button class="board-tool${mode === 'pan' ? ' on' : ''}" data-act="boardMode">${gestureLabel(mode)}</button>
      <button class="board-tool" data-act="boardFollow">▶ Follow game</button>
      <button class="board-tool board-closebtn" data-act="boardClose">✕ Close</button>
    </div>`
  document.body.appendChild(overlay)
  const board = new Board3D(overlay)
  setPhoneBoard(board)
  board.setTheme(getTheme())
  board.setRoam(true) // free roaming — the camera is the player's
  board.setGestureMode(mode) // the stored pan/orbit preference
  board.sync(v)
  // tap any tile for its details: price, rent, owner
  board.onTileTap = (space) => showPropInfo(space)
  // one pushed entry per open, exactly like a sheet: same URL, so the
  // update pill and the ?code= prefill are untouched
  history.pushState({ mpBoard: 1 }, '', location.href)
  boardEntry = true
  const tools = overlay.querySelector('.board-tools') as HTMLElement
  tools.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('[data-act]') as HTMLElement | null
    if (!btn) return
    if (btn.dataset.act === 'boardClose') {
      closeBoard()
    } else if (btn.dataset.act === 'boardReset') {
      getPhoneBoard()?.resetRoamView()
      const follow = tools.querySelector('[data-act="boardFollow"]') as HTMLElement | null
      if (follow) {
        follow.classList.remove('on')
        follow.textContent = '▶ Follow game'
      }
    } else if (btn.dataset.act === 'boardMode') {
      // imperative update — a full render() here would re-init WebGL
      const next: GestureMode = getPhoneBoard()?.getGestureMode() === 'pan' ? 'orbit' : 'pan'
      getPhoneBoard()?.setGestureMode(next)
      localStorage.setItem(GESTURE_FLAG, next)
      btn.classList.toggle('on', next === 'pan')
      btn.textContent = gestureLabel(next)
    } else if (btn.dataset.act === 'boardFollow') {
      const on = btn.classList.toggle('on')
      // following = TV-style tracking (with its snap-back); off = roaming
      getPhoneBoard()?.setRoam(!on)
      btn.textContent = on ? '⏸ Roam free' : '▶ Follow game'
    }
  })
}

export function closeBoard(): void {
  // The pushed entry is consumed exactly once, sheet-style: a UI close pops
  // it via history.back() (the popstate handler recognises its own pop), a
  // real Android back has already popped it — history.state no longer
  // carries mpBoard, so no second back fires.
  const hadEntry = boardEntry
  boardEntry = false
  getPhoneBoard()?.dispose()
  setPhoneBoard(null)
  document.querySelector('.board-overlay')?.remove()
  if (hadEntry) {
    const st = history.state as { mpBoard?: number } | null
    if (st?.mpBoard && !getPopGuard()) {
      setPopGuard(true)
      history.back()
    }
  }
  if (getView() || getLobby()) render()
}

// A roaming board stays live with the game — called on every view push.
export function syncBoard(v: PlayerView): void {
  getPhoneBoard()?.sync(v)
}

// ── property info card ──
// Shared by the pocket board (tap a tile), the table's deed chips and the
// trade strips: every path lands on the same title-deed card, no
// management buttons here (ruled) — just the card and a Close row.
export function showPropInfo(space: number): void {
  const v = getView()
  if (!v) return
  document.querySelector('.propinfo-overlay')?.remove()
  const overlay = document.createElement('div')
  overlay.className = 'propinfo-overlay'
  overlay.innerHTML = `
    <div class="propinfo-card">
      ${deedFull(v, space, avathumb)}
      <div class="row"><button data-act="propInfoClose">Close</button></div>
    </div>`
  overlay.addEventListener('click', (ev) => {
    if ((ev.target as HTMLElement).closest('[data-act="propInfoClose"]') || ev.target === overlay) overlay.remove()
  })
  document.body.appendChild(overlay)
}

// ── the attention ding ──
// A soft chime whenever the game starts waiting on THIS phone: your turn,
// a purchase decision, your bid, the wheel, a debt, a trade offer — any
// time your action set appears or changes. Pure WebAudio, no assets.
let audioCtx: AudioContext | null = null
let prevAllowedKey = ''
let dingArmed = false

function ding(): void {
  try {
    audioCtx ??= new AudioContext()
    if (audioCtx.state === 'suspended') void audioCtx.resume()
    const t = audioCtx.currentTime
    const o = audioCtx.createOscillator()
    const g = audioCtx.createGain()
    o.type = 'sine'
    o.frequency.setValueAtTime(880, t)
    o.frequency.exponentialRampToValueAtTime(1318, t + 0.09)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55)
    o.connect(g)
    g.connect(audioCtx.destination)
    o.start(t)
    o.stop(t + 0.6)
  } catch {
    /* no audio available — the visual cues carry it */
  }
}

export function maybeDing(v: PlayerView): void {
  const key = (v.allowed || []).join(',')
  if (dingArmed && getDingOn() && key.length > 0 && key !== prevAllowedKey) ding()
  prevAllowedKey = key
  dingArmed = true
}

// ── lobby reset: two-step confirmation ──
// Dissolving the room is worse than leaving it — every seat goes. Two
// steps, different wording each, per the council ruling.
export function showResetConfirm(step: 1 | 2): void {
  document.querySelector('.confirm-overlay')?.remove()
  const overlay = document.createElement('div')
  overlay.className = 'confirm-overlay'
  overlay.dataset.step = String(step)
  overlay.innerHTML = `
    <div class="confirm-box">
      <div class="confirm-title">${step === 1 ? 'Start a fresh room?' : 'Really start over?'}</div>
      <p class="confirm-body">${
        step === 1
          ? 'The current room closes and everyone gets the new room code. Seated players rejoin from their phones.'
          : 'Final confirmation — the room code changes now.'
      }</p>
      <div class="row">
        <button data-act="resetCancel">${step === 1 ? 'Keep this room' : 'Stay'}</button>
        <button class="danger" data-act="resetContinue">${step === 1 ? 'Continue' : 'Yes, new room'}</button>
      </div>
      <p class="hint confirm-step">Confirmation ${step} of 2</p>
    </div>`
  overlay.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('[data-act]') as HTMLElement | null
    if (!btn) {
      if (ev.target === overlay) overlay.remove()
      return
    }
    if (btn.dataset.act === 'resetCancel') overlay.remove()
    else if (btn.dataset.act === 'resetContinue') {
      if (overlay.dataset.step === '1') showResetConfirm(2)
      else {
        overlay.remove()
        if (!socket.connected) return toast('Reconnecting — hang on a sec')
        socket.emit('room:reset', (res: { ok: boolean; error?: string }) => {
          if (!res.ok) toast(res.error ?? 'Could not start a new room')
        })
      }
    }
  })
  document.body.appendChild(overlay)
}

// ── the GO salary moment ──
// Crossing GO credits instantly server-side; the phone still makes a moment
// of it — a Collect $200 prompt stands between the roll and the end-turn
// button, so the salary feels earned instead of silently appearing.
let goPromptTurn = -1
let firstViewSeen = false

export function maybeShowGoPrompt(v: PlayerView): void {
  const crossed = v.you === v.currentPlayerId &&
    v.ledger.some((e) => e.playerId === v.you && e.turn === v.turn && e.delta > 0 && e.memo === 'Passed GO')
  if (crossed && goPromptTurn !== v.turn) {
    goPromptTurn = v.turn
    if (firstViewSeen) showGoPrompt()
  }
}

function showGoPrompt(): void {
  const overlay = document.createElement('div')
  overlay.className = 'confirm-overlay'
  overlay.innerHTML = `
    <div class="confirm-box">
      <div class="confirm-title">🟩 You passed GO!</div>
      <p class="confirm-body">Collect your <b>$200</b> salary.</p>
      <div class="row"><button class="good" data-act="collectGo">Collect $200</button></div>
    </div>`
  overlay.addEventListener('click', (ev) => {
    if ((ev.target as HTMLElement).closest('[data-act="collectGo"]')) overlay.remove()
  })
  document.body.appendChild(overlay)
}

// Set by the view handler after the moment checks ran: the very first
// view of a game is only a baseline (joining mid-turn must not replay
// moments), so the GO prompt waits for the second view like everything
// else.
export function markFirstViewSeen(): void {
  firstViewSeen = true
}
