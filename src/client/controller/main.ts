// ── Phone controller ──
// Your wallet, your properties, your decisions — plus the full transaction
// ledger for every player. The server tells us what we're allowed to do
// (PlayerView.allowed) and the shared rules helpers give per-property
// affordances. Card spaces are interactive: open the chest / spin the wheel,
// and the reveal animates here and on the TV.

import { io } from 'socket.io-client'
import { BOARD, GROUP_COLORS, GROUP_LABEL, KIND_COLORS, groupIndices, isStreet } from '../../shared/board.js'
import { TOKENS, stripEmoji } from '../../shared/tokens.js'
import { COLORS } from '../../shared/colors.js'
import { AvatarPreview, avatarThumbnail } from '../tokens3d.js'
import { Board3D } from '../host/board3d.js'
import { startUpdater } from '../version-check.js'
import { cardFace, deedChip, deedFull } from '../deed-card.js'
import { cardEffectLine, debtWhy } from '../../shared/card-effect.js'
import {
  canBuildOn,
  canMortgageOn,
  canSellHouseOn,
  canUnmortgageOn,
  debtBlurb,
  netWorth,
  rentFor,
  rentPreview,
  unmortgageCost,
} from '../../shared/rules.js'
import type { Action, Card, ColorGroup, LobbyInfo, PlayerView, Space, TradeOffer, TradeSide, WaitingKind } from '../../shared/types.js'

interface JoinAck {
  ok: boolean
  code?: string
  playerId?: string
  token?: string
  error?: string
}
interface RejoinAck {
  ok: boolean
  code?: string
  playerId?: string
  error?: string
}

const $app = document.getElementById('app') as HTMLElement
// The patch-managed layer: a SIBLING of $app (renderGame rebuilds all of
// $app via innerHTML on every server push; the sheets that must survive
// those rebuilds mount here and are patched in place).
const $chrome = document.getElementById('chrome') as HTMLElement

// ── theme ──
type Theme = 'light' | 'dark'
let theme: Theme = (localStorage.getItem('mp-theme') as Theme | null) ?? 'light'
document.documentElement.dataset.theme = theme

// ── the attention ding's on/off (persisted per browser) ──
let dingOn = (localStorage.getItem('mp-ding') ?? '1') !== '0'

let view: PlayerView | null = null
let lobby: LobbyInfo | null = null
let myName = ''
let myToken: string | null = localStorage.getItem('mp-token')
let myPlayerId: string | null = localStorage.getItem('mp-playerid')

// Trade composer state survives re-renders AND sheet closes: a view push
// patches the open sheet in place (inputs untouched), and closing it only
// hides the draft — reopening shows it exactly as it was left.
interface Composer {
  partner: string
  giveCash: number
  giveSpaces: number[]
  giveJail: number
  recvCash: number
  recvSpaces: number[]
  recvJail: number
}
let composer: Composer | null = null

// ── the sheet system ──
// ONE sheet at a time (the pocket board is deliberately NOT a sheet —
// it is the full-screen WebGL overlay with its own toolbar). Every close
// funnels through closeSheet(): the ✕, the backdrop, Escape, Android
// back and the Leave teardown are one code path, so none can double-fire.
// The chrome patcher mounts/patches (never rebuilds) whichever sheet is
// open — the composer's input-survival guarantee rides on that.
type SheetKind = 'deeds' | 'more' | 'composer'
const SHEET_KINDS: readonly SheetKind[] = ['deeds', 'more', 'composer']
const SHEET_IDS: Record<SheetKind, string> = { deeds: 'chromeDeeds', more: 'chromeMore', composer: 'chromeComposer' }
const SHEET_CLASSES: Record<SheetKind, string> = { deeds: 'deeds-sheet', more: 'more-sheet', composer: '' }
const SHEET_CLOSE_ACTS: Record<SheetKind, string> = { deeds: 'closeDeeds', more: 'closeMore', composer: 'closeTrade' }
const SHEET_LABELS: Record<SheetKind, string> = {
  deeds: 'Title deeds',
  more: 'More tools',
  composer: 'Propose a trade',
}
let sheet: SheetKind | null = null
// who had focus before the sheet opened (restored on close)
let sheetFocusSaved: HTMLElement | null = null
// true while our own history.back() is consuming the pushed sheet entry —
// the popstate handler recognises its own pop and stands down
let popGuard = false

// Deed grid filters: owner is 'ALL' | 'UNOWNED' | a playerId; kind is 'ALL' |
// a color-group key | 'rail' | 'utility'. Both single-select, AND-combined.
let deedFilters = { owner: 'ALL' as string, kind: 'ALL' as string }
const GROUP_ORDER: ColorGroup[] = ['brown', 'lightblue', 'pink', 'orange', 'red', 'yellow', 'green', 'blue']

// animation bookkeeping
let lastCardSeq = -1

// ledger tab (defaults to "me")
let ledgerTab: string | null = null

// the piece picked on the join screen (defaults to the first in the list)
let joinPiece = TOKENS[0]

// Join flow, two steps: name first, then the piece. The piece step shows a
// live 3D preview of the avatar the emoji is tied to — what you pick here
// is exactly what walks the TV board.
let joinStage: 'name' | 'piece' = 'name'
let joinCode = ''
let joinName = ''
const joinTaken = new Set<string>() // pieces the server refused as taken
let avatarPreview: AvatarPreview | null = null
// the colour picked on the join screen (defaults to the first in the list)
let joinColor = COLORS[0]
// optimistic selections in the lobby (cleared once the broadcast lands)
let lobbySel: string | null = null
let lobbyColorSel: string | null = null

function disposeAvatarPreview(): void {
  avatarPreview?.dispose()
  avatarPreview = null
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

// the player's 3D avatar in their chosen colour — replaces the emoji
// beside every name in the game (thumbnails are cached per model+colour)
function avathumb(p?: { token: string; color: string } | null): string {
  if (!p) return ''
  if (!TOKENS.includes(p.token)) return `${esc(p.token)} `
  return `<img class="avathumb" src="${avatarThumbnail(TOKENS.indexOf(p.token), p.color)}" alt="${esc(p.token)}" draggable="false" /> `
}

function toast(msg: string): void {
  const t = document.createElement('div')
  t.className = 'toast'
  t.textContent = msg
  document.body.appendChild(t)
  setTimeout(() => t.remove(), 2600)
}

// Countdown ticker — updates every countdown surface in place so a
// running timer never re-renders (and never steals focus from inputs).
// Three surfaces share it: the last-30s own-decision chip, the your-move
// bar's tail, and the spectator banner tail.
function clockFmt(rem: number): string {
  return `${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, '0')}`
}
setInterval(() => {
  const tick = (id: string, fmt: (rem: number) => string): void => {
    const el = document.getElementById(id) as HTMLElement | null
    if (!el) return
    const until = Number(el.dataset.until ?? 0)
    const rem = Math.max(0, Math.ceil((until - Date.now()) / 1000))
    const span = el.querySelector('span') ?? el
    span.textContent = fmt(rem)
    // the last-10s urgency marks the whole control (the bar button, the chip)
    ;(el.closest('button') ?? el).classList.toggle('urgent', rem <= 10)
  }
  tick('deadlineChip', (r) => `${r}s`)
  tick('barCount', (r) => ` — ${r}s`)
  tick('waitTail', (r) => ` — ${clockFmt(r)}`)
}, 250)

// ── the sheet system's one open / one close path ──

// Open a sheet. Opening one closes another: the pushed history entry is
// REPLACED on a switch (still exactly one entry to pop on close) and
// PUSHED on a fresh open — always the same URL, so the update pill and
// the ?code= prefill are untouched. Mounting (inside updateChrome) does
// the open-time side effects: focus capture, scroll lock, first control.
function openSheet(kind: SheetKind): void {
  if (sheet === kind) return
  const switching = sheet != null
  sheet = kind
  if (switching) history.replaceState({ mpSheet: kind }, '', location.href)
  else history.pushState({ mpSheet: kind }, '', location.href)
  updateChrome(view)
}

// THE one close path. The composer's draft survives (hide, never lose).
// The pushed history entry is consumed exactly once: a UI close pops it
// via history.back() (the popstate handler recognises its own pop), a
// real Android back has already popped it — history.state no longer
// carries mpSheet, so no second back fires.
function closeSheet(): void {
  if (!sheet) return
  const el = document.getElementById(SHEET_IDS[sheet])
  sheet = null
  delete document.body.dataset.sheet
  const saved = sheetFocusSaved
  sheetFocusSaved = null
  el?.remove()
  composerSigLast = ''
  deedsSigLast = ''
  if (saved && saved.isConnected) saved.focus()
  const st = history.state as { mpSheet?: string } | null
  if (st?.mpSheet && !popGuard) {
    popGuard = true
    history.back()
  }
  updateDock(view)
  updateMoveBar(view)
}

// Android back / browser back: the popstate is either our own pop (the
// sheet is already closed — stand down) or the user's (close, exactly once).
window.addEventListener('popstate', (ev) => {
  if (popGuard) {
    popGuard = false
    return
  }
  if (sheet && !(ev.state as { mpSheet?: string } | null)?.mpSheet) closeSheet()
})

// Dialog keyboard semantics: Escape closes (one path — closeSheet), and
// Tab / Shift-Tab cycle within the open sheet. The dock sits ABOVE sheets
// but outside the cycle: the sheet is the dialog, the dock is furniture.
// A body-level overlay stacked above (confirm, reveal, propinfo, the
// roller, the board) owns the screen instead — Escape stands down.
document.addEventListener('keydown', (ev) => {
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

// ── card reveal overlay (chest opens / wheel spins) ──

function showReveal(card: Card, effectLine?: string): void {
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

// ── the frozen card-effect line ──
// Dynamic effect copy (repairs totals, pay-each counts) is computed ONCE
// per cardDrawSeq, at draw time, and reused for the whole reveal: a
// repairs bill can never shrink mid-reveal while a 90s raise-funds
// window and autoSettle mutate the estate. Static lines are immune by
// construction; recomputing on a seq bump covers a mid-reveal join too.
let frozenCardSeq = -1
let frozenEffectLine = ''

function freezeEffectLine(v: PlayerView): void {
  if (v.cardDrawSeq === frozenCardSeq && v.pendingCard) return
  frozenCardSeq = v.cardDrawSeq
  frozenEffectLine =
    v.pendingCard && v.cardDrawSeq > 0 ? cardEffectLine(v.pendingCard, v, v.currentPlayerId) ?? '' : ''
}

// ── two-step exit confirmation ──
// Leaving is the one destructive thing a phone can do to itself: mid-game
// it's an immediate forfeit — the estate goes under the hammer, the game
// plays on, and this phone can never rejoin. So it takes TWO separate
// confirmations, with different wording each step so neither can be
// muscle-memoryed.
function showExitConfirm(step: 1 | 2): void {
  document.querySelector('.confirm-overlay')?.remove()
  const inGame = view != null
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
      if (overlay.dataset.step === '1') showExitConfirm(2)
      else performExit()
    }
  })
  document.body.appendChild(overlay)
}

function performExit(): void {
  document.querySelector('.confirm-overlay')?.remove()
  if (!ensureConnected()) return
  socket.emit('room:leave', {}, () => {
    localStorage.removeItem('mp-token')
    localStorage.removeItem('mp-playerid')
    myToken = null
    myPlayerId = null
    lobby = null
    view = null
    composer = null
    lastCardSeq = -1
    resetScreenStates()
    render()
  })
}

// Seat gone (leave, kick, room closed): every screen-local state must go
// back to cold. A rejoin's first view is then a fresh baseline — the old
// roll machine must not replay the previous seat's last roll, and a dead
// sheet must not greet the join screen. closeSheet funnels the teardown
// (DOM, scroll lock, focus, the pushed history entry).
function resetScreenStates(): void {
  closeSheet()
  deedFilters = { owner: 'ALL', kind: 'ALL' }
  rollSeen = false
  rollKey = ''
  rollPrevHadDice = false
  rollPrevPhase = ''
  frozenCardSeq = -1
  frozenEffectLine = ''
}

// ── one-step action confirmation ──
// Money moves players regret get exactly one chance to back out.
function showActionConfirm(title: string, body: string, confirmLabel: string, onConfirm: () => void): void {
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
function showRenameEditor(current: string): void {
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
          myName = name
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
//
// The roll state machine (council ruling, replaces the old lastRollKey
// dedupe): dice are a NEW roll only when they first appear (the previous
// view had none) or when the previous view sat in the ROLL phase (a doubles
// re-roll). Anything else that mutates the view's dice — the fresh utility
// roll behind a drawn card, a re-pushed view during a freeze — never
// replays the animation. The very first view of any kind is only a
// baseline: joining/reloading mid-turn must not replay a rolled roll.
let rollKey = ''
let rollPrevHadDice = false
let rollPrevPhase: PlayerView['phase'] | '' = ''
let rollSeen = false

// The bystander strip re-emits inside the main template for its lifetime,
// so a view push mid-strip rebuilds it instead of orphaning it.
let diceStrip: { html: string; until: number } | null = null

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
  diceStrip = { html: diceStripHTML(v, until), until }
  document.querySelectorAll('.dice-strip').forEach((n) => n.remove())
  $app.querySelector('.banner')?.insertAdjacentHTML('afterend', diceStrip.html)
  setTimeout(() => {
    document.querySelectorAll('.dice-strip').forEach((n) => {
      if (Number((n as HTMLElement).dataset.until ?? 0) <= Date.now() + 50) n.remove()
    })
    if (diceStrip && Date.now() >= diceStrip.until) diceStrip = null
  }, 2600)
}

const rollKeyOf = (v: PlayerView): string =>
  v.dice ? `${v.turn}:${v.currentPlayerId}:${v.dice.join(',')}` : ''

function maybeShowRoll(v: PlayerView): void {
  const key = rollKeyOf(v)
  if (!rollSeen) {
    rollSeen = true // first view of any kind = baseline; never animate it
  } else if (key && key !== rollKey && (!rollPrevHadDice || rollPrevPhase === 'ROLL')) {
    showRollOverlay(v) // a NEW roll: first appearance of dice, or a re-roll from the ROLL phase
  }
  rollKey = key
  rollPrevHadDice = v.dice != null
  rollPrevPhase = v.phase
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

// ── wallet pulse ──
// Every cash change counts to the new balance with a floating delta chip —
// money visibly moves instead of silently renumbering.
let lastCash: number | null = null
let moneyRaf = 0

function animateMoney(from: number, to: number): void {
  cancelAnimationFrame(moneyRaf)
  const t0 = performance.now()
  const dur = 700
  const step = (t: number): void => {
    const chip = document.getElementById('moneyChip')
    if (!chip) return // re-rendered away; the fresh paint already shows `to`
    const k = Math.min(1, (t - t0) / dur)
    const eased = 1 - Math.pow(1 - k, 3)
    chip.firstChild!.textContent = `$${Math.round(from + (to - from) * eased)}`
    if (k < 1) moneyRaf = requestAnimationFrame(step)
  }
  moneyRaf = requestAnimationFrame(step)

  const chip = document.getElementById('moneyChip')
  if (chip) {
    const float = document.createElement('span')
    float.className = `money-float ${to >= from ? 'plus' : 'minus'}`
    float.textContent = `${to >= from ? '+' : '−'}$${Math.abs(to - from)}`
    chip.appendChild(float)
    setTimeout(() => float.remove(), 1500)
  }
}

// ── pocket board ──
// The full 3D board on the phone: FREE roaming by default — drag to orbit,
// pinch to zoom, and the view stays exactly where you leave it. Reset
// snaps back to the whole-board overview, Follow re-pins to the action,
// Close returns to the controller. It stays live with the game while open.
// The dock's Board button is the permanent entry point — discovery is
// structural now, no one-time promo needed.
let phoneBoard: Board3D | null = null

// Persisted single-finger gesture verb for the pocket board: 'pan' (map-style
// lateral drag, the default) or 'orbit'. Stored per browser.
const GESTURE_FLAG = 'mp-board-gesture'
type GestureMode = 'pan' | 'orbit'
const gestureLabel = (m: GestureMode): string => (m === 'pan' ? '✋ Pan' : '🔄 Orbit')

function showBoard(): void {
  if (!view) return
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
  phoneBoard = new Board3D(overlay)
  phoneBoard.setTheme(theme)
  phoneBoard.setRoam(true) // free roaming — the camera is the player's
  phoneBoard.setGestureMode(mode) // the stored pan/orbit preference
  phoneBoard.sync(view)
  // tap any tile for its details: price, rent, owner
  phoneBoard.onTileTap = (space) => showPropInfo(space)
  const tools = overlay.querySelector('.board-tools') as HTMLElement
  tools.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('[data-act]') as HTMLElement | null
    if (!btn) return
    if (btn.dataset.act === 'boardClose') {
      closeBoard()
    } else if (btn.dataset.act === 'boardReset') {
      phoneBoard?.resetRoamView()
      const follow = tools.querySelector('[data-act="boardFollow"]') as HTMLElement | null
      if (follow) {
        follow.classList.remove('on')
        follow.textContent = '▶ Follow game'
      }
    } else if (btn.dataset.act === 'boardMode') {
      // imperative update — a full render() here would re-init WebGL
      const next: GestureMode = phoneBoard?.getGestureMode() === 'pan' ? 'orbit' : 'pan'
      phoneBoard?.setGestureMode(next)
      localStorage.setItem(GESTURE_FLAG, next)
      btn.classList.toggle('on', next === 'pan')
      btn.textContent = gestureLabel(next)
    } else if (btn.dataset.act === 'boardFollow') {
      const on = btn.classList.toggle('on')
      // following = TV-style tracking (with its snap-back); off = roaming
      phoneBoard?.setRoam(!on)
      btn.textContent = on ? '⏸ Roam free' : '▶ Follow game'
    }
  })
}

function closeBoard(): void {
  phoneBoard?.dispose()
  phoneBoard = null
  document.querySelector('.board-overlay')?.remove()
  if (view || lobby) render()
}

// ── the title deed ──
// ONE component now (src/client/deed-card.ts), shared with the TV: the
// full rent ladder with exactly one is-now row, mortgage math, the owner
// and set progress. deedFull is pure display — never a button, never any
// baked-in actions. The deeds grid composes manageButtons BELOW the
// returned card (a .deed-actions row); every other surface is read-only.

// The per-viewer "would make N/M" copy for a purchase decision (buy
// prompt / auction): counted on THIS phone's holdings, and when the
// purchase would complete the viewer's set, said in money.
function wouldMakeCopy(v: PlayerView, i: number): string {
  const sp = BOARD[i]
  if (!('price' in sp)) return ''
  if (isStreet(sp)) {
    const set = groupIndices(sp.group)
    const have = set.filter((j) => v.props[j].owner === v.you).length // the space itself is unowned here
    if (have + 1 === set.length) return `base $${sp.rents[0]} - doubles to $${sp.rents[0] * 2} for you`
    return `would make ${have + 1}/${set.length} in the set`
  }
  if (sp.kind === 'rail') {
    const n = [5, 15, 25, 35].filter((j) => v.props[j].owner === v.you).length
    return `would make ${n + 1}/4 railroads`
  }
  const n = [12, 28].filter((j) => v.props[j].owner === v.you).length
  return `would make ${n + 1}/2 utilities`
}

// Trade flags: the doubled delta computed for the recipient's post-trade
// holdings, and the symmetric break on the giving side. Trades never carry
// buildings (the engine refuses), so the delta is always base rent.
function completesSetCopy(v: PlayerView, i: number): string {
  const sp = BOARD[i]
  if (!isStreet(sp)) return ''
  const set = groupIndices(sp.group)
  const have = set.filter((j) => j !== i && v.props[j].owner === v.you).length
  if (have !== set.length - 1) return ''
  return `$${sp.rents[0]} -> $${sp.rents[0] * 2} when this completes your set`
}

function breaksSetCopy(v: PlayerView, i: number): string {
  const sp = BOARD[i]
  if (!isStreet(sp)) return ''
  const set = groupIndices(sp.group)
  if (!set.every((j) => v.props[j].owner === v.you)) return ''
  return `breaks your set - $${sp.rents[0] * 2} -> $${sp.rents[0]}`
}

// A portfolio's management buttons — THE gate: they render exactly when the
// server's allowed list plus the shared rules checks agree. renderPortfolio
// and the deeds grid both call this, so neither can drift from the engine.
function manageButtons(v: PlayerView, pid: string, i: number): string[] {
  const sp: Space = BOARD[i]
  const acts = new Set(v.allowed)
  const btns: string[] = []
  if (acts.has('buyHouse') && canBuildOn(v, pid, i)) btns.push(`<button class="tiny" data-act="buyHouse" data-args='{"space":${i}}'>House +$${isStreet(sp) ? sp.houseCost : ''}</button>`)
  if (acts.has('sellHouse') && canSellHouseOn(v, pid, i)) btns.push(`<button class="tiny" data-act="sellHouse" data-args='{"space":${i}}'>Sell house +$${isStreet(sp) ? sp.houseCost / 2 : ''}</button>`)
  if (acts.has('mortgage') && canMortgageOn(v, pid, i)) btns.push(`<button class="tiny" data-act="mortgage" data-args='{"space":${i}}'>Mortgage +$${('price' in sp ? sp.price : 0) / 2}</button>`)
  if (acts.has('unmortgage') && canUnmortgageOn(v, pid, i)) btns.push(`<button class="tiny" data-act="unmortgage" data-args='{"space":${i}}'>Unmortgage −$${unmortgageCost('price' in sp ? sp.price : 0)}</button>`)
  return btns
}

// ── property info card ──
// Shared by the pocket board (tap a tile), the table's deed chips and the
// trade strips: every path lands on the same title-deed card, no
// management buttons here (ruled) — just the card and a Close row.
function showPropInfo(space: number): void {
  const v = view
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

function maybeDing(v: PlayerView): void {
  const key = (v.allowed || []).join(',')
  if (dingArmed && dingOn && key.length > 0 && key !== prevAllowedKey) ding()
  prevAllowedKey = key
  dingArmed = true
}

// ── lobby reset: two-step confirmation ──
// Dissolving the room is worse than leaving it — every seat goes. Two
// steps, different wording each, per the council ruling.
function showResetConfirm(step: 1 | 2): void {
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

function maybeShowGoPrompt(v: PlayerView): void {
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

// ── Connection lifecycle ──

const preCode = (new URLSearchParams(location.search).get('code') ?? '')
  .toUpperCase()
  .replace(/[^A-Z]/g, '')
  .slice(0, 4)

// True while a stored rejoin token is being checked — show a connecting card
// instead of flashing the join form at a returning player.
let rejoinPending = myToken != null

// Fires on the FIRST connect and on every automatic reconnect (Wi-Fi blip,
// screen lock, server restart). The stored token reattaches the seat —
// wallet, deeds and jail cards intact. This is the seamless-rejoin path.
const socket = io()
// update detection: pockets hold stale tabs for hours — prompt when the
// server moves on (reload is safe: the rejoin token restores the seat)
startUpdater({
  socket,
  title: 'Update ready',
  note: 'Tap Refresh — you keep your seat and your cash.',
  button: 'Refresh',
})
socket.on('connect', () => {
  if (!myToken) return
  rejoinPending = true
  socket.emit('room:rejoin', { token: myToken }, (res: RejoinAck) => {
    if (res.ok) {
      myPlayerId = res.playerId ?? myPlayerId
      localStorage.setItem('mp-playerid', myPlayerId ?? '')
    } else {
      localStorage.removeItem('mp-token')
      localStorage.removeItem('mp-playerid')
      myToken = null
      myPlayerId = null
    }
    rejoinPending = false
    render()
  })
})

socket.on('lobby', (l: LobbyInfo) => {
  lobby = l
  view = null
  rejoinPending = false
  // screen transition: the game-only sheets die with the game view
  if (sheet) closeSheet()
  render()
})

// The party host dissolved the room and minted a fresh one — land on the
// join screen with the new code (and your name) prefilled; no auto-rejoin,
// the seat assignment is yours to remake.
socket.on('room:closed', (p: { code?: string }) => {
  const code = p.code ?? ''
  const name = myName
  localStorage.removeItem('mp-token')
  localStorage.removeItem('mp-playerid')
  myToken = null
  myPlayerId = null
  lobby = null
  view = null
  composer = null
  lobbySel = null
  resetScreenStates()
  joinStage = 'name'
  if (/^[A-Z]{4}$/.test(code)) joinCode = code
  if (name) joinName = name
  render()
  toast('This room was closed — join the new room')
})

// The host removed this seat — back to the join screen, politely. Mid-game
// removals are estate forfeits (a different message); lobby kicks are just
// seat removals.
socket.on('kicked', () => {
  const midGame = view != null
  localStorage.removeItem('mp-token')
  localStorage.removeItem('mp-playerid')
  myToken = null
  myPlayerId = null
  lobby = null
  view = null
  composer = null
  lobbySel = null
  resetScreenStates()
  render()
  toast(midGame ? 'The host removed you from the game' : 'The host removed you from the room')
})

socket.on('view', (v: PlayerView) => {
  const enteringGame = view == null
  view = v
  lobby = null
  rejoinPending = false
  // entering the game from the lobby/join screen: sheets start closed;
  // view pushes DURING the game keep whichever sheet is open, patched
  if (enteringGame) {
    if (sheet) closeSheet()
    deedFilters = { owner: 'ALL', kind: 'ALL' }
  }

  // freeze the effect line at draw time (repairs totals and pay-each
  // counts must never drift mid-reveal), then reveal on the drawer's phone
  freezeEffectLine(v)
  if (v.cardDrawSeq > lastCardSeq && lastCardSeq >= 0 && v.pendingCard && v.currentPlayerId === v.you) {
    showReveal(v.pendingCard, frozenEffectLine || undefined)
  }
  lastCardSeq = v.cardDrawSeq

  render()
  maybeShowRoll(v)
  maybeShowGoPrompt(v)
  maybeDing(v)
  firstViewSeen = true
  // a roaming board stays live with the game
  phoneBoard?.sync(v)
})

// ── Actions ──

// A dead socket silently queues emits forever — every player-initiated
// send must say so instead of swallowing the tap.
function ensureConnected(): boolean {
  if (socket.connected) return true
  toast('Reconnecting — hang on a sec')
  return false
}

function send(a: Action): void {
  if (!ensureConnected()) return
  socket.emit('game:action', a, (res: { ok: boolean; error?: string }) => {
    if (!res.ok) toast(res.error ?? 'Not allowed right now')
  })
}

// One delegated handler serves BOTH roots: $app (the rebuilt main flow)
// and $chrome (the patch-managed sheets) are siblings, so a tap inside a
// sheet never bubbles through $app's listener — the same handler must be
// registered on each root.
function onActionClick(ev: MouseEvent): void {
  const el = (ev.target as HTMLElement).closest('[data-act]') as HTMLElement | null
  if (!el) return
  const act = el.dataset.act
  const args = JSON.parse(el.dataset.args ?? '{}') as Record<string, unknown>

  switch (act) {
    case 'theme': {
      theme = theme === 'light' ? 'dark' : 'light'
      localStorage.setItem('mp-theme', theme)
      document.documentElement.dataset.theme = theme
      // imperative: the More sheet's label patches in place, nothing re-renders
      const label = document.querySelector('[data-mi="theme"]') as HTMLElement | null
      if (label) label.textContent = theme === 'light' ? '🌙 Dark theme' : '☀️ Light theme'
      break
    }
    case 'dingToggle': {
      dingOn = !dingOn
      localStorage.setItem('mp-ding', dingOn ? '1' : '0')
      const label = document.querySelector('[data-mi="ding"]') as HTMLElement | null
      if (label) label.textContent = dingOn ? '🔔 Sound ding on' : '🔇 Sound ding off'
      break
    }
    case 'joinNext': {
      const code = (document.getElementById('code') as HTMLInputElement).value.trim().toUpperCase()
      const name = stripEmoji((document.getElementById('name') as HTMLInputElement).value)
      if (!/^[A-Z]{4}$/.test(code)) return toast('Enter the 4-letter room code')
      if (!name) return toast('Enter your name first')
      joinCode = code
      joinName = name
      joinStage = 'piece'
      renderJoin()
      break
    }
    case 'joinBack': {
      joinStage = 'name'
      renderJoin()
      break
    }
    case 'join': {
      if (!ensureConnected()) return
      socket.emit('room:join', { code: joinCode, name: joinName, piece: joinPiece, color: joinColor }, (res: JoinAck) => {
        if (!res.ok) {
          // a taken model or colour gets crossed out in the grid, not just a toast
          const m = /(\S+) is already taken/.exec(res.error ?? '')
          if (m) {
            if (TOKENS.includes(m[1])) joinTaken.add(m[1])
            renderJoin()
            toast(`${m[1]} is taken — pick another`)
            return
          }
          return toast(res.error ?? 'Could not join')
        }
        localStorage.setItem('mp-token', res.token ?? '')
        myToken = res.token ?? null
        myPlayerId = res.playerId ?? null
        localStorage.setItem('mp-playerid', myPlayerId ?? '')
        myName = joinName
      })
      break
    }
    case 'pickPiece': {
      // toggle imperatively — a full re-render would restart the preview
      joinPiece = el.dataset.piece ?? joinPiece
      document.querySelectorAll('.tok').forEach((b) => {
        b.classList.toggle('sel', (b as HTMLElement).dataset.piece === joinPiece)
      })
      avatarPreview?.show(TOKENS.indexOf(joinPiece), joinColor)
      break
    }
    case 'pickColor': {
      joinColor = el.dataset.color ?? joinColor
      document.querySelectorAll('.swatch').forEach((b) => {
        b.classList.toggle('sel', (b as HTMLElement).dataset.color === joinColor)
      })
      avatarPreview?.show(TOKENS.indexOf(joinPiece), joinColor)
      break
    }
    case 'lobbyPiece': {
      // change your model in the lobby — optimistic selection, server
      // confirms with a lobby broadcast (or rejects a taken model)
      const piece = el.dataset.piece ?? ''
      const wearing = lobby?.players.find((p) => p.id === myPlayerId)?.token
      if (!piece || piece === wearing) return
      lobbySel = piece
      document.querySelectorAll('.tok').forEach((b) => {
        b.classList.toggle('sel', (b as HTMLElement).dataset.piece === piece)
      })
      avatarPreview?.show(TOKENS.indexOf(piece), lobbyColorSel ?? lobby?.players.find((p) => p.id === myPlayerId)?.color ?? COLORS[0])
      socket.emit('room:setPiece', { piece }, (res: { ok: boolean; error?: string }) => {
        if (!res.ok) {
          toast(res.error ?? 'Could not change piece')
          lobbySel = null
          render() // back to what you're actually wearing
        } else {
          joinPiece = piece
          lobbySel = null
        }
      })
      break
    }
    case 'lobbyColor': {
      // change your colour in the lobby — the avatar wears it on the board
      const color = el.dataset.color ?? ''
      const wearing = lobby?.players.find((p) => p.id === myPlayerId)?.color
      if (!color || color === wearing) return
      lobbyColorSel = color
      document.querySelectorAll('.swatch').forEach((b) => {
        b.classList.toggle('sel', (b as HTMLElement).dataset.color === color)
      })
      avatarPreview?.show(TOKENS.indexOf(lobbySel ?? lobby?.players.find((p) => p.id === myPlayerId)?.token ?? TOKENS[0]), color)
      socket.emit('room:setColor', { color }, (res: { ok: boolean; error?: string }) => {
        if (!res.ok) {
          toast(res.error ?? 'Could not change colour')
          lobbyColorSel = null
          render()
        } else {
          lobbyColorSel = null
        }
      })
      break
    }
    case 'resetRoom': {
      showResetConfirm(1)
      break
    }
    case 'kickPlayer': {
      const target = lobby?.players.find((p) => p.id === String(args.id))
      if (!lobby || !target) return
      showActionConfirm(
        'Kick this player?',
        `Remove <b>${avathumb(target)}${esc(target.name)}</b> from the room - they can rejoin with the room code until the game starts.`,
        'Kick',
        () => {
          if (!ensureConnected()) return
          socket.emit('room:kick', { playerId: target.id }, (res: { ok: boolean; error?: string }) => {
            if (!res.ok) toast(res.error ?? 'Could not kick')
          })
        },
      )
      break
    }
    case 'editName': {
      // your own lobby row's ✎ — prefilled with the seat's current name
      const me = lobby?.players.find((p) => p.id === myPlayerId)
      if (!lobby || !me) return
      showRenameEditor(me.name)
      break
    }
    case 'startGame': {
      socket.emit('game:start', {}, (res: { ok: boolean; error?: string }) => {
        if (!res.ok) toast(res.error ?? 'Could not start the game')
      })
      break
    }
    case 'handOver': {
      socket.emit('game:handOver', { to: String(args.to) }, (res: { ok: boolean; error?: string }) => {
        if (!res.ok) toast(res.error ?? 'Could not hand over host duties')
      })
      break
    }
    case 'leave': {
      // Both exits (lobby "Leave room" and the More sheet's "Leave the
      // game") start the same two-step confirmation — see showExitConfirm.
      // The sheet closes FIRST (the funneled closeSheet), so it can never
      // linger dead under the confirm overlay's step-1 backdrop.
      if (sheet) closeSheet()
      showExitConfirm(1)
      break
    }
    case 'propInfo': {
      showPropInfo(Number(args.space))
      break
    }
    case 'showBoard': {
      // the board is NOT a sheet: it overlays everything, and whatever
      // sheet was open simply waits underneath (unchanged, still patched)
      showBoard()
      break
    }
    case 'openMore': {
      if (sheet === 'more') closeSheet() // the dock toggles its sheet
      else openSheet('more')
      break
    }
    case 'closeMore': closeSheet(); break
    case 'openDeeds': {
      // plain open (dock) starts from default filters; table rows pass
      // their player as the owner filter
      if (sheet === 'deeds' && !args.owner) {
        closeSheet()
        break
      }
      deedFilters = { owner: args.owner ? String(args.owner) : 'ALL', kind: 'ALL' }
      openSheet('deeds')
      break
    }
    case 'closeDeeds': closeSheet(); break
    case 'deedOwner': {
      const owner = String(args.owner)
      deedFilters = { ...deedFilters, owner: deedFilters.owner === owner ? 'ALL' : owner }
      updateChrome(view)
      break
    }
    case 'deedKind': {
      const kind = String(args.kind)
      deedFilters = { ...deedFilters, kind: deedFilters.kind === kind ? 'ALL' : kind }
      updateChrome(view)
      break
    }
    case 'deedClearFilters':
      deedFilters = { owner: 'ALL', kind: 'ALL' }
      updateChrome(view)
      break
    case 'roll': send({ type: 'roll' }); break
    case 'drawCard': send({ type: 'drawCard' }); break
    case 'goToJail': send({ type: 'goToJail' }); break
    case 'buy': send({ type: 'buy' }); break
    case 'declineBuy': send({ type: 'declineBuy' }); break
    case 'endTurn': send({ type: 'endTurn' }); break
    case 'bid': send({ type: 'bid', amount: Number(args.amount) }); break
    case 'bidCustom': {
      const input = document.getElementById('bidAmount') as HTMLInputElement | null
      const n = Number(input?.value ?? 0)
      if (!n) return toast('Enter a bid')
      send({ type: 'bid', amount: n })
      break
    }
    case 'passBid': send({ type: 'passBid' }); break
    case 'payTax': send({ type: 'payTax', choice: args.choice as 'flat' | 'percent' }); break
    case 'payJail': send({ type: 'payJail' }); break
    case 'useJailCard': send({ type: 'useJailCard' }); break
    case 'payDebt': send({ type: 'payDebt' }); break
    case 'bankrupt': send({ type: 'bankrupt' }); break
    case 'buyHouse': send({ type: 'buyHouse', space: Number(args.space) }); break
    case 'sellHouse': send({ type: 'sellHouse', space: Number(args.space) }); break
    case 'mortgage': {
      // Mortgage: money now, income never — one chance to back out.
      const space = Number(args.space)
      const sp = view ? BOARD[space] : null
      const price = sp && 'price' in sp ? sp.price : 0
      showActionConfirm(
        'Mortgage this property?',
        `Take <b>$${price / 2}</b> from the bank for <b>${sp ? esc(sp.name) : 'this deed'}</b> — it earns nothing until you lift the mortgage.`,
        'Mortgage it',
        () => send({ type: 'mortgage', space }),
      )
      break
    }
    case 'unmortgage': {
      const space = Number(args.space)
      const sp = view ? BOARD[space] : null
      const cost = sp && 'price' in sp ? unmortgageCost(sp.price) : 0
      showActionConfirm(
        'Lift the mortgage?',
        `Pay <b>$${cost}</b> (price + 10%) to wake <b>${sp ? esc(sp.name) : 'this deed'}</b> back up.`,
        'Lift mortgage',
        () => send({ type: 'unmortgage', space }),
      )
      break
    }
    case 'acceptTrade': send({ type: 'respondTrade', tradeId: String(args.id), accept: true }); break
    case 'declineTrade': send({ type: 'respondTrade', tradeId: String(args.id), accept: false }); break
    case 'cancelTrade': send({ type: 'cancelTrade', tradeId: String(args.id) }); break
    case 'ledgerTab': ledgerTab = String(args.id); render(); break
    case 'openTrade': {
      const v = view
      if (!v) return
      // the dock toggles its sheet; a half-built draft reopens intact
      if (sheet === 'composer') {
        closeSheet()
        break
      }
      if (!composer) {
        const partners = v.players.filter((p) => !p.bankrupt && p.id !== v.you)
        if (partners.length === 0) return toast('Nobody to trade with!')
        composer = {
          partner: partners[0]?.id ?? '',
          giveCash: 0, giveSpaces: [], giveJail: 0,
          recvCash: 0, recvSpaces: [], recvJail: 0,
        }
      }
      openSheet('composer')
      break
    }
    case 'closeTrade': closeSheet(); break // hide, never lose — the draft stays
    case 'sendTrade': {
      if (!composer) return
      const give: TradeSide = { cash: Math.max(0, Math.floor(composer.giveCash)), spaces: composer.giveSpaces, jailCards: composer.giveJail }
      const receive: TradeSide = { cash: Math.max(0, Math.floor(composer.recvCash)), spaces: composer.recvSpaces, jailCards: composer.recvJail }
      if (give.cash === 0 && give.spaces.length === 0 && give.jailCards === 0 && receive.cash === 0 && receive.spaces.length === 0 && receive.jailCards === 0) {
        return toast('Offer something!')
      }
      if (!ensureConnected()) return
      // the draft is only spent when the server accepts it — a refusal
      // (freeze, vanished partner) keeps the composer open, intact
      socket.emit('game:action', { type: 'proposeTrade', to: composer.partner, give, receive }, (res: { ok: boolean; error?: string }) => {
        if (!res.ok) return toast(res.error ?? 'Not allowed right now')
        composer = null
        if (sheet === 'composer') closeSheet()
      })
      break
    }
    case 'barJump': {
      // the your-move bar's tap: close whatever covers the action card,
      // then jump to it and pulse it (~600ms)
      if (phoneBoard) closeBoard() // re-renders the main flow underneath
      if (sheet) closeSheet()
      requestAnimationFrame(() => {
        const card = (document.querySelector('main .card.actions') ?? document.querySelector('main .card')) as HTMLElement | null
        if (!card) return
        card.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' })
        card.classList.add('pulse-card')
        setTimeout(() => card.classList.remove('pulse-card'), 650)
      })
      break
    }
    case 'composerPartner': if (composer) { composer.partner = String(args.partner); render() } break
    case 'toggleGiveSpace': {
      if (!composer) return
      const i = Number(args.space)
      composer.giveSpaces = composer.giveSpaces.includes(i) ? composer.giveSpaces.filter((x) => x !== i) : [...composer.giveSpaces, i]
      render()
      break
    }
    case 'toggleRecvSpace': {
      if (!composer) return
      const i = Number(args.space)
      composer.recvSpaces = composer.recvSpaces.includes(i) ? composer.recvSpaces.filter((x) => x !== i) : [...composer.recvSpaces, i]
      render()
      break
    }
    case 'composerJail': {
      const v = view
      if (!composer || !v) return
      if (args.side === 'give') composer.giveJail = Math.max(0, Math.min(meOf(v).jailCards, composer.giveJail === 0 ? 1 : 0))
      else composer.recvJail = Math.max(0, Math.min(partnerPlayer(v, composer.partner)?.jailCards ?? 0, composer.recvJail === 0 ? 1 : 0))
      render()
      break
    }
  }
}

$app.addEventListener('click', onActionClick)
$chrome.addEventListener('click', onActionClick)

// The composer's cash inputs live in #chrome now; the same delegated
// input handler covers both roots. Writes only the composer STATE — the
// input element itself is never touched by a patch (focus/contents ride).
function onComposerInput(ev: Event): void {
  const el = ev.target as HTMLInputElement
  if (!el.dataset.k || !composer) return
  const v = view
  if (!v) return
  const n = Math.max(0, Math.floor(Number(el.value) || 0))
  if (el.dataset.k === 'giveCash') composer.giveCash = Math.min(n, meOf(v).cash)
  if (el.dataset.k === 'recvCash') composer.recvCash = Math.min(n, partnerPlayer(v, composer.partner)?.cash ?? 0)
}

$app.addEventListener('input', onComposerInput)
$chrome.addEventListener('input', onComposerInput)

function meOf(v: PlayerView | null) {
  return v?.players.find((p) => p.id === v.you) ?? { id: '', name: '', color: '', token: '', cash: 0, pos: 0, jail: false, jailRolls: 0, jailCards: 0, jailReason: null, bankrupt: false, connected: false }
}
function partnerPlayer(v: PlayerView | null, pid: string) {
  return v?.players.find((p) => p.id === pid)
}

// ── Render ──

function render(): void {
  if (view || rejoinPending) disposeAvatarPreview()
  if (view) {
    renderGame(view)
    return
  }
  // No game view (join screen, lobby, reconnecting): the game-only sheets
  // die with the game view, exactly as they did when they lived in $app.
  updateChrome(null)
  if (lobby) {
    renderLobby(lobby)
    return
  }
  if (rejoinPending) {
    $app.innerHTML = `
      <div class="join">
        <div class="card">
          <h2>Reconnecting…</h2>
          <p class="hint">Finding your seat in the game.</p>
        </div>
      </div>`
    return
  }
  renderJoin()
}

function renderJoin(): void {
  disposeAvatarPreview()
  if (joinStage === 'name') {
    $app.innerHTML = `
      <div class="join">
        <h1>MONOPOLY PARTY</h1>
        <div class="card">
          <label>Room code</label>
          <input id="code" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="ABCD" value="${esc(preCode || joinCode)}" />
          <label>Your name <span class="hint-inline">(no emojis)</span></label>
          <input id="name" maxlength="16" autocomplete="off" placeholder="e.g. Maya" value="${esc(joinName)}" />
          <button class="big primary" data-act="joinNext">Next — pick your piece</button>
          <p class="hint">Get the code from the TV screen</p>
        </div>
      </div>`
    return
  }
  // model + colour stage: tap a 3D avatar and a colour, previewed live
  $app.innerHTML = `
    <div class="join">
      <h1>MONOPOLY PARTY</h1>
      <div class="card">
        <div class="join-summary">Room <b>${esc(joinCode)}</b> · playing as <b>${esc(joinName)}</b> <button class="tiny" data-act="joinBack">Change</button></div>
        <label>Choose your piece</label>
        <div class="tokgrid">
          ${TOKENS.map(
            (t) =>
              `<button type="button" class="tok${t === joinPiece ? ' sel' : ''}${joinTaken.has(t) ? ' taken' : ''}" data-piece="${t}" data-act="pickPiece"${joinTaken.has(t) ? ' disabled' : ''}><img src="${avatarThumbnail(TOKENS.indexOf(t))}" alt="${t}" draggable="false" /></button>`,
          ).join('')}
        </div>
        <label>Choose your colour</label>
        <div class="swatchgrid">
          ${COLORS.map(
            (c) => `<button type="button" class="swatch${c === joinColor ? ' sel' : ''}" style="background:${c}" data-color="${c}" data-act="pickColor" aria-label="colour ${c}"></button>`,
          ).join('')}
        </div>
        <div id="avatarStage"></div>
        <button class="big primary" data-act="join">Join as ${esc(joinName)}</button>
        <p class="hint">Each piece is its own 3D avatar — it walks the board in your colour.</p>
      </div>
    </div>`
  const stage = document.getElementById('avatarStage')
  if (stage) {
    avatarPreview = new AvatarPreview(stage)
    avatarPreview.show(TOKENS.indexOf(joinPiece), joinColor)
  }
}

function renderLobby(l: LobbyInfo): void {
  disposeAvatarPreview()
  const isHost = myPlayerId != null && myPlayerId === l.hostId
  const me = l.players.find((p) => p.id === myPlayerId)
  const players = l.players
    .map((p) => {
      const kick = isHost && p.id !== myPlayerId ? `<button class="tiny kickbtn" data-act="kickPlayer" data-args='{"id":"${p.id}"}' title="Kick from the room">✕</button>` : ''
      // your own row: the only seat whose name you can edit
      const pen = p.id === myPlayerId ? `<button class="tiny renamebtn" data-act="editName" title="Change your name">✎</button>` : ''
      return `<li${p.id === l.hostId ? ' class="crowned"' : ''}><span class="dot" style="background:${p.color}"></span>${avathumb(p)}${esc(p.name)}${p.id === l.hostId ? ' <span class="crown">Host</span>' : ''}${p.connected ? '' : '<em class="off"> (offline)</em>'}${pen}${kick}</li>`
    })
    .join('')
  const others = l.players.filter((p) => p.id !== myPlayerId)
  const myPiece = lobbySel ?? me?.token ?? TOKENS[0]
  const myColor = lobbyColorSel ?? me?.color ?? COLORS[0]
  // your model + colour are yours to change until the game starts
  const seatEditor = me ? `
      <label>Your piece — tap to change</label>
      <div class="tokgrid">
        ${TOKENS.map(
          (t) =>
            `<button type="button" class="tok${t === myPiece ? ' sel' : ''}${l.players.some((p) => p.id !== myPlayerId && p.token === t) ? ' taken' : ''}" data-piece="${t}" data-act="lobbyPiece"${t === myPiece || l.players.some((p) => p.id !== myPlayerId && p.token === t) ? ' disabled' : ''}><img src="${avatarThumbnail(TOKENS.indexOf(t))}" alt="${t}" draggable="false" /></button>`,
        ).join('')}
      </div>
      <label>Your colour — tap to change</label>
      <div class="swatchgrid">
        ${COLORS.map(
          (c) =>
            `<button type="button" class="swatch${c === myColor ? ' sel' : ''}${l.players.some((p) => p.id !== myPlayerId && p.color === c) ? ' taken' : ''}" style="background:${c}" data-color="${c}" data-act="lobbyColor"${c === myColor || l.players.some((p) => p.id !== myPlayerId && p.color === c) ? ' disabled' : ''} aria-label="colour ${c}"></button>`,
        ).join('')}
      </div>
      <div id="avatarStage"></div>` : ''
  $app.innerHTML = `
    <div class="card">
      <h2>Room ${esc(l.code)}</h2>
      <p class="good">You're in${isHost ? ' — and you\u2019re the party host' : ''}.</p>
      <h3>Players (${l.players.length})</h3>
      <ul class="playerlist">${players}</ul>
      ${seatEditor}
      ${isHost ? `
        <button class="big primary" data-act="startGame" ${l.canStart ? '' : 'disabled'}>Start the game</button>
        ${!l.canStart ? '<p class="hint">Best with 3+ players — waiting…</p>' : ''}
        ${others.length > 0 ? `
          <label>Hand over host duties</label>
          <div class="chips">${others.map((p) => `<button class="chip" data-act="handOver" data-args='{"to":"${p.id}"}'>Host: ${esc(p.name)}</button>`).join('')}</div>` : ''}
        <div class="row"><button class="tiny danger" data-act="resetRoom">New room code</button></div>
      ` : '<p class="hint">Waiting for the host to start the game…<br/>Keep this tab open.</p>'}
      <div class="row"><button class="tiny" data-act="leave">Leave room</button></div>
    </div>`
  // live 3D preview of the piece you're wearing (or about to take), in your colour
  const stage = document.getElementById('avatarStage')
  if (stage && me) {
    avatarPreview = new AvatarPreview(stage)
    avatarPreview.show(TOKENS.indexOf(myPiece), myColor)
  }
  // pre-warm the exact (model, colour) thumbnails the first game frame
  // will need, while the player is still reading the lobby
  setTimeout(() => {
    for (const p of l.players) {
      if (TOKENS.includes(p.token)) avatarThumbnail(TOKENS.indexOf(p.token), p.color)
    }
  }, 0)
}

// The debt banner's deed chip: the exact amount plus the WHY recomputed
// from live state — houses tier, full-set doubling or the dice product —
// never parsed from the memo. Rent debts get the chip; card debts keep
// the plain debtBlurb text.
function debtChipRow(v: PlayerView, d: { debtor: string; amount: number; creditor: string | null; memo?: string }): string {
  if (!d.memo?.startsWith('Rent: ')) return ''
  const i = BOARD.findIndex((sp) => sp.name === d.memo!.slice(6))
  if (i < 0) return ''
  return `<div class="debt-chiprow">${deedChip(v, i, { value: `$${d.amount}`, flag: debtWhy(v, d) })}</div>`
}

// The spectator countdown tail: someone ELSE'S blocking decision with an
// armed clock gets an honest live tail on the waiting banner (the
// last-30s own-decision chip stays as is — that one is yours). An armed
// clock you can still act on (auction bid/pass) is yours, not a tail.
function spectatorTail(v: PlayerView): string {
  if (v.deadline == null || !v.waitingOn) return ''
  if (v.waitingOn.playerId === v.you) return ''
  if (v.waitingOn.kind === 'auc' && (v.allowed.includes('bid') || v.allowed.includes('passBid'))) return ''
  return `<span class="wt" id="waitTail" data-until="${v.deadline}"></span>`
}

function renderGame(v: PlayerView): void {
  const I = meOf(v)
  if (!I.id) {
    $app.innerHTML = `<div class="card"><h2>Spectating</h2><p class="hint">This room's game is already running.</p></div>`
    updateChrome(v)
    return
  }
  const cur = v.players.find((p) => p.id === v.currentPlayerId)
  const acts = new Set(v.allowed)
  const worth = netWorth(v, I.id)

  // wallet pulse bookkeeping: the previous balance animates to this one
  const prevCash = lastCash
  lastCash = I.cash

  let banner = ''
  let body = ''

  // What the active player drew — a card face, NEVER a blocker: the action
  // cascade below must always render so the game can always advance. The
  // effect line is the frozen one (a repairs bill can't shrink mid-reveal).
  let drawStrip = ''
  if (v.pendingCard && !v.pendingCardDraw) {
    drawStrip = cardFace(v.pendingCard, frozenEffectLine || undefined)
  }

  // What the active player just landed on, as the shared deed chip —
  // visible on every phone so the table shares one mental model of the
  // board. The number is the live rentFor gated on the mortgage (a
  // mortgaged deed collects nothing — never print a rent due for it).
  let landedStrip = ''
  if (v.lastLanded && v.lastLanded.playerId === v.currentPlayerId) {
    const i = v.lastLanded.space
    const sp = BOARD[i]
    const drawer = v.players.find((p) => p.id === v.currentPlayerId)
    const who = I.id === v.currentPlayerId ? 'You' : `${avathumb(drawer)}${esc(drawer?.name ?? '')}`
    const diceSum = v.dice ? v.dice[0] + v.dice[1] : 7
    let rentLine = ''
    let chipVal: string | undefined
    if ('price' in sp) {
      const st = v.props[i]
      const owner = st.owner ? v.players.find((p) => p.id === st.owner) : null
      if (owner && owner.id === v.currentPlayerId) {
        if (st.mortgaged) {
          rentLine = '<span class="ls-rent">Yours — <b>mortgaged, earns nothing</b></span>'
        } else {
          const rent = rentFor(v, i, diceSum)
          chipVal = `$${rent}`
          rentLine = `<span class="ls-rent">Yours — earns <b>$${rent}</b></span>`
        }
      } else if (owner) {
        if (st.mortgaged) {
          rentLine = `<span class="ls-rent"><b>no rent - mortgaged</b> — ${avathumb(owner)}${esc(owner.name)}'s</span>`
        } else {
          const rent = rentFor(v, i, diceSum)
          chipVal = `$${rent}`
          const whose = owner.id === I.id ? '<b>yours to collect</b>' : `${avathumb(owner)}${esc(owner.name)}`
          rentLine = `<span class="ls-rent">Rent due: <b>$${rent}</b> — ${whose}</span>`
        }
      } else {
        chipVal = `$${sp.price}`
        const rp = rentPreview(v, i)
        const baseCopy = sp.kind === 'utility' ? rp.note : `$${rp.current}`
        rentLine = `<span class="ls-rent">Rent: <b>${baseCopy}</b> when owned</span>`
      }
    }
    landedStrip = `<div class="landedstrip">${who} landed on ${deedChip(v, i, { value: chipVal })}${rentLine}</div>`
  }

  // Deadline chip: the 300s decision clock is hidden until its final
  // 30 seconds — then it's impossible to ignore.
  let deadlineChip = ''
  if (v.deadline != null && (v.deadlineFor === I.id || v.deadlineFor === null)) {
    const rem = v.deadline - Date.now()
    if (rem <= 30_000) {
      deadlineChip = `<div class="deadline${rem <= 10_000 ? ' urgent' : ''}" id="deadlineChip" data-until="${v.deadline}"><span>${Math.max(0, Math.ceil(rem / 1000))}s</span> left — make your move!</div>`
    }
  }

  // ── Contextual status (mutually exclusive) ──
  if (v.phase === 'GAME_OVER' || v.winner) {
    const winner = v.players.find((p) => p.id === v.winner)
    banner = `<div class="banner ${winner?.id === I.id ? 'good' : ''}">${winner ? `${esc(winner.name)} wins!` : 'Game over'}</div>`
  } else if (v.phase === 'DEBT' && v.debt && v.debt.debtor === I.id) {
    const creditor = v.debt.creditor ? v.players.find((p) => p.id === v.debt?.creditor) : null
    const canPay = acts.has('payDebt')
    // Rent debts carry the why-math on a deed chip below the banner;
    // card debts keep the one-phrase debtBlurb text.
    const isRent = !!v.debt.memo?.startsWith('Rent: ')
    banner = `<div class="banner debt">You owe <b>$${v.debt.amount}</b> to ${creditor ? `${avathumb(creditor)}${esc(creditor.name)}` : 'the bank'}${isRent ? '' : ` — ${esc(debtBlurb(v.debt))}`}</div>${debtChipRow(v, v.debt)}`
    if (canPay) {
      // rent they can afford: a deliberate, felt-in-the-hand payment
      body += `
        <div class="card urgent">
          <h3>Time to pay up</h3>
          <p class="hint">The money leaves your wallet when you tap.</p>
          <button class="big good" data-act="payDebt">Pay $${v.debt.amount}</button>
        </div>`
    } else {
      body += `
        <div class="card urgent">
          <h3>Raise the money</h3>
          <p>Sell houses or mortgage properties below, then tap Pay.</p>
          <button class="big danger" data-act="bankrupt">Declare bankruptcy</button>
        </div>`
    }
  } else if (v.phase === 'DEBT' && v.debt) {
    const debtor = v.players.find((p) => p.id === v.debt?.debtor)
    const creditor = v.debt.creditor ? v.players.find((p) => p.id === v.debt?.creditor) : null
    // Rent debts carry the why-math on a deed chip below the banner; card
    // debts keep the one-phrase debtBlurb text.
    const isRent = !!v.debt.memo?.startsWith('Rent: ')
    // A relay card queues several payments through one freeze. If I'M the one
    // getting paid, show how much of the relay is still owed to me.
    const dq = v.debtQueue || []
    let relay = ''
    if (v.debt.creditor === I.id && dq.some((d) => d.creditor === I.id)) {
      const mine = 1 + dq.filter((d) => d.creditor === I.id).length
      relay = ` — <b>${mine} of ${1 + dq.length} still to pay</b>`
    }
    banner = `<div class="banner info">${avathumb(debtor)}${esc(debtor?.name ?? '')} is paying ${creditor ? `${avathumb(creditor)}${esc(creditor.name)}` : 'the bank'} <b>$${v.debt.amount}</b>${isRent ? '' : ` — ${esc(debtBlurb(v.debt))}`}${relay}${spectatorTail(v)}</div>${debtChipRow(v, v.debt)}`
  } else if (v.phase === 'AUCTION' && v.auction) {
    const bidder = v.players.find((p) => p.id === v.auction?.bidder)
    const mine = v.auction.bidder === I.id
    banner = `<div class="banner auction">Auction: ${deedChip(v, v.auction.space, { value: `$${v.auction.bid}` })}${bidder ? ` — high bidder: <b>${esc(bidder.name)}</b>` : ' — no bids yet'}${spectatorTail(v)}</div>`
    if (mine) {
      body += `<div class="card"><h3>You're the high bidder</h3><p class="hint">Waiting for the others…</p></div>`
    } else if (acts.has('bid') || acts.has('passBid')) {
      const au = v.auction
      const min = au.bid + 1
      const highBidder = au.bidder ? v.players.find((p) => p.id === au.bidder) : null
      body += `
        <div class="card">
          ${deedFull(v, au.space, avathumb)}
          <p class="hint">${wouldMakeCopy(v, au.space)}</p>
          <h3>Place your bid${au.bid > 0 ? ` — current bid <b>$${au.bid}</b>${highBidder ? ` (${esc(highBidder.name)})` : ''}` : ' — no bids yet'}</h3>
          <div class="row">
            <button data-act="bid" data-args='{"amount":${min}}'>$${min}</button>
            <button data-act="bid" data-args='{"amount":${au.bid + 10}}'>+$10</button>
            <button data-act="bid" data-args='{"amount":${au.bid + 50}}'>+$50</button>
          </div>
          <div class="row">
            <input id="bidAmount" type="number" inputmode="numeric" placeholder="custom $${min}+" />
            <button data-act="bidCustom">Bid</button>
            <button class="danger" data-act="passBid">Pass</button>
          </div>
        </div>`
    } else {
      body += `<div class="card"><p class="hint">Waiting for bids…</p></div>`
    }
  } else if (v.pendingCardDraw && v.pendingCardDraw.player === I.id) {
    const isChest = v.pendingCardDraw.deck === 'chest'
    banner = `<div class="banner ${isChest ? 'card-chest' : 'card-chance'}">You landed on <b>${isChest ? 'Community Chest' : 'Chance'}</b></div>`
    body += `<div class="card actions">
      <button class="big primary" data-act="drawCard">${isChest ? 'Open the Community Chest' : 'Spin the wheel'}</button>
    </div>`
  } else if (v.pendingCardDraw) {
    banner = `<div class="banner info">${cur ? esc(cur.name) : 'The active player'} landed on ${v.pendingCardDraw.deck === 'chest' ? 'Community Chest' : 'Chance'} — waiting for the reveal…${spectatorTail(v)}</div>`
  } else if (v.pendingJail && v.pendingJail.player === I.id) {
    const reason = v.pendingJail.reason === 'space'
      ? 'you landed on Go To Jail'
      : v.pendingJail.reason === 'card'
        ? 'the card says: Go directly to Jail'
        : 'you rolled three doubles in a row'
    banner = `<div class="banner debt">You're under arrest — ${reason}</div>`
    body += `<div class="card actions">
      <button class="big danger" data-act="goToJail">Go to Jail</button>
      <p class="hint">The sentence starts when you tap — the table is watching.</p>
    </div>`
  } else if (v.pendingJail) {
    const arrested = v.players.find((p) => p.id === v.pendingJail?.player)
    banner = `<div class="banner info">${avathumb(arrested)}${esc(arrested?.name ?? '')} is under arrest — waiting for them to go to jail…${spectatorTail(v)}</div>`
  } else if (v.phase === 'ROLL' && I.id === v.currentPlayerId) {
    banner = `<div class="banner good">Your turn${I.jail ? ` — you're in jail (${I.jailReason ?? 'sentenced earlier'})` : ''}</div>`
    body += `<div class="card actions">
      <button class="big primary" data-act="roll">Roll the dice</button>
      ${I.jail ? `
        <h3 style="margin-top:12px">Jail — attempt ${I.jailRolls}/3</h3>
        <div class="row">
          ${acts.has('payJail') ? `<button data-act="payJail">Pay $50 fine</button>` : ''}
          ${acts.has('useJailCard') ? `<button data-act="useJailCard">Use jail card</button>` : ''}
        </div>` : ''}
    </div>`
  } else if (v.phase === 'ACTION' && I.id === v.currentPlayerId) {
    if (v.pendingPurchase != null) {
      const sp = BOARD[v.pendingPurchase]
      const price = 'price' in sp ? sp.price : 0
      banner = `<div class="banner good">You landed on <b>${esc(sp.name)}</b></div>`
      body += `<div class="card actions">
        ${deedFull(v, v.pendingPurchase, avathumb)}
        <p class="hint">${wouldMakeCopy(v, v.pendingPurchase)}</p>
        <div class="row">
          ${acts.has('buy') ? `<button class="big good" data-act="buy">Buy for $${price}</button>` : `<button class="big disabled" disabled>Can't afford $${price}</button>`}
          ${acts.has('declineBuy') ? `<button class="big" data-act="declineBuy">Send to auction</button>` : ''}
        </div>
      </div>`
    } else if (v.pendingTax && v.pendingTax.player === I.id) {
      const percentCost = Math.ceil(netWorth(v, I.id) / 10)
      banner = `<div class="banner good">Income Tax</div>`
      body += `<div class="card actions">
        <h3>Choose your payment</h3>
        <div class="row">
          ${acts.has('payTax') ? `<button data-act="payTax" data-args='{"choice":"flat"}'>Pay flat $200</button>` : ''}
          ${acts.has('payTax') ? `<button data-act="payTax" data-args='{"choice":"percent"}'>Pay 10% of worth ($${percentCost})</button>` : ''}
        </div>
      </div>`
    } else {
      banner = `<div class="banner info">You rolled — you can still build or trade before ending your turn.</div>`
      body += `<div class="card actions"><button class="big primary" data-act="endTurn">End turn</button></div>`
    }
  } else if (I.bankrupt) {
    // An eliminated seat spectates: allowedActions is empty, so no
    // affordances render — never tell a bankrupt player they can still
    // build or trade. The ledger, table and deeds stay as read-only views.
    banner = `<div class="banner debt">💀 You're bankrupt — enjoy the show</div>`
  } else {
    banner = `<div class="banner info">${cur ? `${avathumb(cur)}<b>${esc(cur.name)}</b>'s turn` : 'Waiting…'}${spectatorTail(v)}</div>`
    body += `<div class="card"><p class="hint">You can still build, mortgage, and trade.</p></div>`
  }

  // ── Trades ──
  const incoming = v.trades.filter((t) => t.to === I.id)
  const outgoing = v.trades.filter((t) => t.from === I.id)
  if (incoming.length > 0) {
    body += `<div class="trades"><h3>INCOMING OFFERS</h3>${incoming.map((t) => tradeCard(v, t, 'incoming')).join('')}</div>`
  }
  if (outgoing.length > 0) {
    body += `<div class="trades"><h3>YOUR OFFERS</h3>${outgoing.map((t) => tradeCard(v, t, 'outgoing')).join('')}</div>`
  }

  // ── My portfolio (a bankrupt seat owns nothing — the table tells the story) ──
  if (!I.bankrupt) body += renderPortfolio(v, I.id)

  // ── New trade button — directly above the transaction history ──
  if (acts.has('proposeTrade')) {
    body += `<button class="big wide" data-act="openTrade">Propose a trade</button>`
  }

  // ── The whole title-deed book: always available, no phase gating ──
  const ownedCount = Object.values(v.props).filter((st) => st.owner === I.id).length
  body += `<button class="big wide" data-act="openDeeds">View properties${ownedCount ? ` · ${ownedCount} owned` : ''}</button>`

  // ── The table at a glance — every player's cash and deeds ──
  body += renderTable(v)

  // ── Transaction history (yours and everyone else's) ──
  body += renderLedger(v, I.id)

  $app.innerHTML = `
    <header class="topbar" style="--c:${I.color}">
      <span class="me">${avathumb(I)}${esc(I.name)}</span>
      <span class="money" id="moneyChip">$${I.cash}</span>
      <span class="meta">worth $${worth}${I.jailCards > 0 ? ` · jail card ×${I.jailCards}` : ''}${I.jail ? ' · in jail' : ''}</span>
    </header>
    ${banner}
    ${diceStrip && Date.now() < diceStrip.until ? diceStrip.html : ''}
    ${landedStrip}
    ${drawStrip}
    ${deadlineChip}
    <main>${body}</main>`

  // The sheets no longer ride in $app's innerHTML: they live in #chrome
  // and are patched in place, so this wholesale rebuild never destroys an
  // open sheet (the composer's inputs keep focus mid-typing, the deeds
  // grid keeps its scroll).
  updateChrome(v)

  // the wallet counts to its new balance, with a floating delta
  if (prevCash != null && prevCash !== I.cash) animateMoney(prevCash, I.cash)
}

// One trade side as chips: rent now, plus the completes-set (receiving)
// or breaks-set (giving) flag computed for THIS phone's post-trade
// holdings. Trades never carry buildings, so the delta is always base
// rent. Tapping a chip opens the full deed.
function sideSummary(v: PlayerView, side: TradeSide, dir: 'toYou' | 'fromYou'): string {
  const parts: string[] = []
  if (side.cash > 0) parts.push(`$${side.cash}`)
  const diceSum = v.dice ? v.dice[0] + v.dice[1] : 7
  for (const i of side.spaces) {
    const st = v.props[i]
    const value = st.mortgaged ? '$0' : `$${rentFor(v, i, diceSum)}`
    const flag = dir === 'toYou' ? completesSetCopy(v, i) : breaksSetCopy(v, i)
    parts.push(deedChip(v, i, { act: 'propInfo', value, flag }))
  }
  if (side.jailCards > 0) parts.push(`jail card ×${side.jailCards}`)
  return parts.join(' + ') || 'nothing'
}

function tradeCard(v: PlayerView, t: TradeOffer, dir: 'incoming' | 'outgoing'): string {
  const from = v.players.find((p) => p.id === t.from)
  const to = v.players.find((p) => p.id === t.to)
  // incoming: the give side flows TO me, the receive side leaves me.
  // outgoing: the give side leaves me, the receive side flows TO me.
  const giveDir = dir === 'incoming' ? 'toYou' : 'fromYou'
  const recvDir = dir === 'incoming' ? 'fromYou' : 'toYou'
  // Accepting moves money and deeds, so it waits out auction/debt freezes
  // (the engine enforces the same rule). Declining or withdrawing is
  // always live — the engine takes it in any phase.
  const frozen = v.phase === 'AUCTION' || v.phase === 'DEBT'
  return `<div class="card trade">
    <div><b>${avathumb(from)}${esc(from?.name ?? '')}</b> offers <b>${sideSummary(v, t.give, giveDir)}</b><br/>in exchange for <b>${sideSummary(v, t.receive, recvDir)}</b> <span class="hint">(${esc(to?.name ?? '')})</span></div>
    ${dir === 'incoming'
      ? `<div class="row"><button class="good" data-act="acceptTrade" data-args='{"id":"${t.id}"}'${frozen ? ' disabled' : ''}>Accept</button><button class="danger" data-act="declineTrade" data-args='{"id":"${t.id}"}'>Decline</button></div>${frozen ? '<p class="hint">Trades pause until this settles</p>' : ''}`
      : `<div class="row"><button data-act="cancelTrade" data-args='{"id":"${t.id}"}'>Withdraw offer</button></div>`}
  </div>`
}

function renderPortfolio(v: PlayerView, pid: string): string {
  const owned = Object.entries(v.props)
    .filter(([, st]) => st.owner === pid)
    .map(([iStr, st]) => ({ i: Number(iStr), st }))
    .sort((a, b) => a.i - b.i)
  if (owned.length === 0) {
    return `<div class="trades"><h3>YOUR PROPERTIES</h3><p class="hint">None yet — land on something and buy it!</p></div>`
  }
  const diceSum = v.dice ? v.dice[0] + v.dice[1] : 7
  const rows = owned
    .map(({ i, st }) => {
      const sp: Space = BOARD[i]
      // the chip carries name, group, house pips and the rent it earns
      // NOW (a mortgaged deed earns $0 — never blank, the hatched swatch
      // + MORTGAGED marker say why); tapping it opens the full deed
      const chipVal = st.mortgaged ? '$0' : `$${rentFor(v, i, diceSum)}`
      // earning line: what the next build tier earns (the now-number is
      // on the chip)
      const rp = rentPreview(v, i)
      let earn = ''
      if (isStreet(sp)) {
        earn = st.houses === 5
          ? 'hotel tier — the top of the ladder'
          : rp.next != null
            ? `next tier <b>$${rp.next}</b> with ${rp.next === sp.rents[5] ? 'a hotel' : 'a house'}${rp.note ? ` · ${rp.note}` : ''}`
            : rp.note ? rp.note : ''
      } else if (sp.kind === 'rail') {
        earn = rp.next != null ? `next tier <b>$${rp.next}</b> with another railroad` : 'all four railroads'
      } else if (sp.kind === 'utility') {
        earn = rp.next != null ? `<b>${rp.next}× dice</b> with both` : 'both utilities — 10× dice'
      }
      if (st.mortgaged) earn = 'mortgaged — no rent while asleep'
      // The server's allowed list is THE gate: a button renders exactly when
      // the engine would accept it (manageButtons — shared with the deeds
      // grid, so the two can never drift). During freezes (auction/debt) the
      // list omits management actions, so the buttons simply don't appear —
      // the phase banner already explains what the table is waiting on.
      const btns = manageButtons(v, pid, i)
      return `<div class="prop">
        ${deedChip(v, i, { act: 'propInfo', value: chipVal })}
        <div class="pinfo">
          ${earn ? `<div class="pearn">${earn}</div>` : ''}
          ${btns.length > 0 ? `<div class="row">${btns.join('')}</div>` : ''}
        </div>
      </div>`
    })
    .join('')
  return `<div class="trades"><h3>YOUR PROPERTIES (${owned.length})</h3>${rows}</div>`
}

// The whole table in one quiet section: every player's cash and their
// deeds as compact colour chips. Tapping a chip opens that deed's card;
// tapping the row opens the full title-deed screen filtered to that player.
function abbrName(sp: Space): string {
  // fit ~8-10 chars: drop the long suffixes, then hard-truncate
  let n = sp.name
    .replace(' Railroad', ' RR')
    .replace('Electric Company', 'Elec Co')
    .replace(' Avenue', '')
    .replace(' Place', '')
    .replace(' Gardens', '')
  return n.length > 10 ? `${n.slice(0, 9)}.` : n
}

function renderTable(v: PlayerView): string {
  const ownable = Object.keys(v.props).length
  const ownedTotal = Object.values(v.props).filter((st) => st.owner != null).length
  // bankrupt players sink to the bottom, dimmed, chipless (their deeds
  // have already been transferred)
  const rows = [...v.players]
    .sort((a, b) => (a.bankrupt === b.bankrupt ? 0 : a.bankrupt ? 1 : -1))
    .map((p) => {
      if (p.bankrupt) {
        return `<div class="trow dead">
          <div class="t-top"><span class="t-name" style="color:${p.color}">${avathumb(p)}💀 ${esc(p.name)}</span><span class="t-cash">$${p.cash}</span></div>
        </div>`
      }
      const chips = Object.entries(v.props)
        .filter(([, st]) => st.owner === p.id)
        .map(([iStr]) => Number(iStr))
        .sort((a, b) => a - b) // board order = colour runs stay together
        .map((i) => deedChip(v, i, { act: 'propInfo', name: abbrName(BOARD[i]) })) // pips only — one tap opens the deed
        .join('')
      return `<div class="trow" data-act="openDeeds" data-args='{"owner":"${p.id}"}'>
        <div class="t-top"><span class="t-name" style="color:${p.color}">${avathumb(p)}${esc(p.name)}</span><span class="t-cash">$${p.cash}</span><span class="t-go" aria-hidden="true">▸</span></div>
        ${chips ? `<div class="t-deeds">${chips}</div>` : ''}
      </div>`
    })
    .join('')
  return `<div class="trades table-sec"><h3>TABLE${ownable ? ` · ${ownedTotal}/${ownable} deeds owned · tap a player for their deeds` : ''}</h3>${rows}</div>`
}

// The full-information money ledger: "All" merges every player's books.
const ALL = '__all__'

function renderLedger(v: PlayerView, meId: string): string {
  const sel = ledgerTab ?? meId
  const all = sel === ALL
  const entries = (all ? v.ledger : v.ledger.filter((e) => e.playerId === sel)).slice(-30).reverse()
  const chips = [
    `<button class="chip ${all ? 'sel' : ''}" data-act="ledgerTab" data-args='{"id":"${ALL}"}'>All</button>`,
    ...v.players.map(
      (p) =>
        `<button class="chip ${p.id === sel ? 'sel' : ''}" style="${p.id === sel ? `border-color:${p.color}` : ''}" data-act="ledgerTab" data-args='{"id":"${p.id}"}' ${p.bankrupt ? 'disabled' : ''}>${avathumb(p)}${esc(p.name)}</button>`,
    ),
  ].join('')
  const rows = entries.length
    ? entries
        .map((e) => {
          const who = v.players.find((p) => p.id === e.playerId)
          const bal = e.balance != null ? `<span class="bal">$${e.balance}</span>` : ''
          return `<li><span class="who" style="color:${who?.color ?? 'inherit'}">${avathumb(who)}</span><span class="amt ${e.delta > 0 ? 'plus' : 'minus'}">${e.delta > 0 ? '+' : '-'}$${Math.abs(e.delta)}</span>${bal}<span class="memo">${esc(e.memo)}</span><span class="lturn">turn ${e.turn}</span></li>`
        })
        .join('')
    : '<li><span class="memo hint">No transactions yet.</span></li>'
  return `<div class="ledger">
    <h3>TRANSACTION HISTORY</h3>
    <div class="chips">${chips}</div>
    <ul class="ledger-list">${rows}</ul>
  </div>`
}

// ── the trade composer sheet (chrome-mounted) ──
// Region builders shared by mount and patch, so the two can never drift.
// The cash INPUTS appear only in composerSheetHTML — the patcher has no
// write path to them at all (focus and typed text survive every push).
function composerPartnersRowHTML(v: PlayerView): string {
  const C = composer
  if (!C) return ''
  return v.players
    .filter((p) => !p.bankrupt && p.id !== v.you)
    .map((p) => `<button class="chip ${C.partner === p.id ? 'sel' : ''}" data-act="composerPartner" data-args='{"partner":"${p.id}"}'>${avathumb(p)}${esc(p.name)}</button>`)
    .join('')
}

function composerChipsHTML(v: PlayerView, forPid: string, selected: number[], which: 'give' | 'recv'): string {
  const spaces = Object.entries(v.props).filter(([, st]) => st.owner === forPid)
  const diceSum = v.dice ? v.dice[0] + v.dice[1] : 7
  const chip = (i: number, sel: boolean): string => {
    const st = v.props[i]
    const value = st.mortgaged ? '$0' : `$${rentFor(v, i, diceSum)}`
    // give side: what leaves me — "breaks your set"; recv side: what
    // arrives — "completes your set". Both are computed for MY post-trade
    // holdings, and both are always base rent (trades never carry buildings).
    const flag = which === 'give' ? breaksSetCopy(v, i) : completesSetCopy(v, i)
    return deedChip(v, i, { act: which === 'give' ? 'toggleGiveSpace' : 'toggleRecvSpace', sel, value, flag })
  }
  const html = spaces.map(([iStr]) => chip(Number(iStr), selected.includes(Number(iStr)))).join('')
  // the recv side keeps its empty-state hint; the give side never had one
  return which === 'recv' ? html || '<span class="hint">they own nothing</span>' : html
}

function composerJailHTML(side: 'give' | 'recv', sel: boolean): string {
  return `<button class="chip ${sel ? 'sel' : ''}" data-act="composerJail" data-args='{"side":"${side}"}'>Jail card</button>`
}

function composerRecvLabelHTML(v: PlayerView): string {
  const partner = composer ? partnerPlayer(v, composer.partner) : null
  return partner ? `${avathumb(partner)}${esc(partner.name)} gives` : 'They give'
}

// The send row renders exactly what allowedActions says: proposing is
// the only thing a freeze takes away, so during one the button is
// disabled with the freeze reason — the draft itself is never lost.
function composerSendRowHTML(v: PlayerView): string {
  if (v.allowed.includes('proposeTrade')) return `<button class="big primary" data-act="sendTrade">Send offer</button>`
  return `<button class="big" disabled>Trades pause until this settles</button>`
}

function composerSheetHTML(v: PlayerView): string {
  const C = composer
  if (!C) return ''
  const I = meOf(v)
  const partner = partnerPlayer(v, C.partner)
  return `
      <h3>Propose a trade</h3>
      <label>Trade with</label>
      <div class="row" data-cp="partners">${composerPartnersRowHTML(v)}</div>
      <label>You give</label>
      <div class="chips" data-cp="giveChips">${composerChipsHTML(v, I.id, C.giveSpaces, 'give')}</div>
      <div class="row" data-cp="giveRow">
        <input data-k="giveCash" type="number" inputmode="numeric" min="0" value="${C.giveCash}" placeholder="cash up to $${I.cash}" />
        ${I.jailCards > 0 ? composerJailHTML('give', C.giveJail > 0) : ''}
      </div>
      <label data-cp="recvLabel">${composerRecvLabelHTML(v)}</label>
      <div class="chips" data-cp="recvChips">${composerChipsHTML(v, C.partner, C.recvSpaces, 'recv')}</div>
      <div class="row" data-cp="recvRow">
        <input data-k="recvCash" type="number" inputmode="numeric" min="0" value="${C.recvCash}" placeholder="cash up to $${partner?.cash ?? 0}" />
        ${(partner?.jailCards ?? 0) > 0 ? composerJailHTML('recv', C.recvJail > 0) : ''}
      </div>
      <div class="row" data-cp="sendRow">${composerSendRowHTML(v)}<button class="big" data-act="closeTrade">Cancel</button></div>`
}

// ── the More sheet (chrome-mounted) ──
// The dock's ⋯: the three phone utilities. Theme and the sound ding
// toggle imperatively (a label patch in place, no render needed); Leave
// is the one destructive row, styled var(--bad) — which passes AA; the
// old #e15b5b is retired. Sheet content only — mountSheet wraps it.
function moreSheetHTML(): string {
  return `
        <button class="menu-item" data-act="theme">
          <span class="mi-label" data-mi="theme">${theme === 'light' ? '🌙 Dark theme' : '☀️ Light theme'}</span>
          <span class="mi-hint">Switch the look of this phone</span>
        </button>
        <button class="menu-item" data-act="dingToggle">
          <span class="mi-label" data-mi="ding">${dingOn ? '🔔 Sound ding on' : '🔇 Sound ding off'}</span>
          <span class="mi-hint">The chime when the game waits on you</span>
        </button>
        <div class="menu-sep"></div>
        <button class="menu-item danger" data-act="leave">
          <span class="mi-label">Leave the game</span>
          <span class="mi-hint">Two confirmations — your estate goes under the hammer</span>
        </button>`
}

// Fully static except the two toggle labels — patch exactly those.
function patchMore(el: HTMLElement): void {
  const themeLabel = el.querySelector('[data-mi="theme"]') as HTMLElement | null
  if (themeLabel) {
    const want = theme === 'light' ? '🌙 Dark theme' : '☀️ Light theme'
    if (themeLabel.textContent !== want) themeLabel.textContent = want
  }
  const dingLabel = el.querySelector('[data-mi="ding"]') as HTMLElement | null
  if (dingLabel) {
    const want = dingOn ? '🔔 Sound ding on' : '🔇 Sound ding off'
    if (dingLabel.textContent !== want) dingLabel.textContent = want
  }
}

// ── the View-properties sheet (chrome-mounted) ──
// Every title deed in the game as one grid of full cards, filtered by owner
// and by kind (two chip rows, single-select each, AND-combined; re-tapping
// the selected chip clears it). Unfiltered it groups by board order under
// colour-run headings; filtered it's one flat grid. Cards show everything
// inline — only your own deeds carry the (server-gated) action buttons.
// Sheet content only — mountSheet wraps it; the chrome patcher re-emits
// it solely when the deedsSig board signature actually changes.
function deedsSheetHTML(v: PlayerView): string {
  const ownable = Object.keys(v.props).length
  const ownedTotal = Object.values(v.props).filter((st) => st.owner != null).length
  const alive = v.players.filter((p) => !p.bankrupt)

  const ownerChips = [
    `<button class="chip ${deedFilters.owner === 'ALL' ? 'sel' : ''}" data-act="deedOwner" data-args='{"owner":"ALL"}'>All</button>`,
    ...alive.map(
      (p) =>
        `<button class="chip ${deedFilters.owner === p.id ? 'sel' : ''}" ${deedFilters.owner === p.id ? `style="border-color:${p.color}"` : ''} data-act="deedOwner" data-args='{"owner":"${p.id}"}'>${avathumb(p)}${esc(p.name)}</button>`,
    ),
    `<button class="chip ${deedFilters.owner === 'UNOWNED' ? 'sel' : ''}" data-act="deedOwner" data-args='{"owner":"UNOWNED"}'>Unowned</button>`,
  ].join('')
  const kindChips = [
    ...GROUP_ORDER.map(
      (g) =>
        `<button class="chip ${deedFilters.kind === g ? 'sel' : ''}" style="--g:${GROUP_COLORS[g]}" data-act="deedKind" data-args='{"kind":"${g}"}'><span class="dstrip"></span>${GROUP_LABEL[g]}</button>`,
    ),
    `<button class="chip ${deedFilters.kind === 'rail' ? 'sel' : ''}" style="--g:${KIND_COLORS.rail}" data-act="deedKind" data-args='{"kind":"rail"}'><span class="dstrip"></span>Railroads</button>`,
    `<button class="chip ${deedFilters.kind === 'utility' ? 'sel' : ''}" style="--g:${KIND_COLORS.utility}" data-act="deedKind" data-args='{"kind":"utility"}'><span class="dstrip"></span>Utilities</button>`,
  ].join('')

  const matches = Object.keys(v.props)
    .map(Number)
    .sort((a, b) => a - b) // board order — colour runs stay together
    .filter((i) => {
      const sp = BOARD[i]
      const st = v.props[i]
      const kindOk =
        deedFilters.kind === 'ALL' || (isStreet(sp) ? sp.group === deedFilters.kind : sp.kind === deedFilters.kind)
      const ownerOk =
        deedFilters.owner === 'ALL' ||
        (deedFilters.owner === 'UNOWNED' ? st.owner == null : st.owner === deedFilters.owner)
      return kindOk && ownerOk
    })

  // one grid cell: the pure-display deed card, with the (server-gated)
  // manage buttons composed BELOW it — never baked into the component
  const cell = (i: number): string => {
    const btns = manageButtons(v, v.you, i)
    return `${deedFull(v, i, avathumb)}${btns.length > 0 ? `<div class="deed-actions row">${btns.join('')}</div>` : ''}`
  }

  let grid = ''
  if (matches.length === 0) {
    const emptyMsg =
      deedFilters.owner === 'UNOWNED' && deedFilters.kind === 'ALL'
        ? 'Every property has an owner.'
        : 'Nothing matches.'
    grid = `<p class="hint deeds-empty">${emptyMsg}</p><div class="row"><button class="wide" data-act="deedClearFilters">Clear filters</button></div>`
  } else if (deedFilters.owner === 'ALL' && deedFilters.kind === 'ALL') {
    // unfiltered: group by board order with a heading per colour run
    const buckets: Array<{ key: string; heading: string; items: number[] }> = []
    for (const i of matches) {
      const sp = BOARD[i]
      const key = isStreet(sp) ? sp.group : sp.kind
      const heading = isStreet(sp)
        ? `${GROUP_LABEL[sp.group]} · ${groupIndices(sp.group).length}`
        : sp.kind === 'rail'
          ? 'Railroads'
          : 'Utilities'
      const last = buckets[buckets.length - 1]
      if (last && last.key === key) last.items.push(i)
      else buckets.push({ key, heading, items: [i] })
    }
    grid = buckets
      .map(
        (b) =>
          `<div class="deed-h">${esc(b.heading)}</div><div class="deedgrid">${b.items.map((i) => cell(i)).join('')}</div>`,
      )
      .join('')
  } else {
    grid = `<div class="deedgrid">${matches.map((i) => cell(i)).join('')}</div>`
  }

  return `
      <div class="deeds-head">
        <h3>PROPERTIES · ${ownedTotal}/${ownable}</h3>
        <button class="deeds-x" data-act="closeDeeds" aria-label="Close">✕</button>
      </div>
      <div class="chips">${ownerChips}</div>
      <div class="chips kind-chips">${kindChips}</div>
      ${grid}`
}

// ── chrome: the in-place patcher ──
// renderGame rebuilds ALL of $app via innerHTML on every server push, so
// everything that must survive those rebuilds lives in the #chrome
// sibling: the dock, the your-move bar and THE sheet (one at a time).
// Each mounts once per open and is then patched, never rebuilt with the
// main flow — a push mid-typing never touches the composer's inputs
// (focus and contents survive), and the deeds grid is left byte-identical
// (scroll intact) unless the board actually changed. Transient momentary
// overlays (card reveal, dice, confirms, GO, the pocket board, propinfo,
// toasts, the update pill) stay body-level and untouched.

// Signatures of the last-applied patch, so unchanged pushes cost zero
// DOM writes (and the deeds grid's scrollTop survives them untouched).
let composerSigLast = ''
let deedsSigLast = ''

// Backdrop tap closes (data-act on .modal — every close act funnels into
// closeSheet); the sheet swallows taps with an empty data-act — the
// composer's shield, unchanged. Mount = the one open moment: dialog
// semantics, focus capture, scroll lock and first-control focus happen
// here and nowhere else.
function mountSheet(id: string, sheetClass: string, sheetHTML: string, backdropAct: string, ariaLabel: string): HTMLElement {
  const modal = document.createElement('div')
  modal.className = 'modal'
  modal.id = id
  modal.dataset.act = backdropAct
  modal.innerHTML = `<div class="sheet ${sheetClass}" role="dialog" aria-modal="true" aria-label="${ariaLabel}" data-act="">${sheetHTML}</div>`
  $chrome.appendChild(modal)
  sheetFocusSaved = document.activeElement instanceof HTMLElement ? document.activeElement : null
  document.body.dataset.sheet = sheet ?? ''
  const first = modal.querySelector<HTMLElement>('button:not([disabled]), input, select, textarea, [href]')
  first?.focus()
  return modal
}

function sheetHTMLFor(kind: SheetKind, v: PlayerView): string {
  if (kind === 'deeds') return deedsSheetHTML(v)
  if (kind === 'more') return moreSheetHTML()
  return composer != null ? composerSheetHTML(v) : ''
}

// ── composer: what its chip regions depend on ──
// The cash INPUTS are deliberately absent from this signature — typing
// changes composer.giveCash/recvCash only, so a push mid-typing finds the
// signature unchanged and performs ZERO DOM writes on the sheet. The chip
// markup (pips, MORTGAGED markers, rent-now values, set flags) reads
// houses + mortgage state too, so those ride along per space.
function composerSig(v: PlayerView): string {
  const C = composer
  if (!C) return ''
  const partner = partnerPlayer(v, C.partner)
  const spacesOf = (pid: string): string[] =>
    Object.entries(v.props)
      .filter(([, st]) => st.owner === pid)
      .map(([i, st]) => `${i}:${st.houses}:${st.mortgaged ? 1 : 0}`)
      .sort()
  return JSON.stringify({
    partners: v.players.filter((p) => !p.bankrupt && p.id !== v.you).map((p) => `${p.id}:${p.jailCards}`),
    partner: C.partner,
    my: spacesOf(v.you),
    their: spacesOf(C.partner),
    give: C.giveSpaces,
    recv: C.recvSpaces,
    myJail: meOf(v).jailCards,
    theirJail: partner?.jailCards ?? 0,
    giveJail: C.giveJail,
    recvJail: C.recvJail,
    // dice ride the signature: a utility chip's rent-now is the dice
    // product, so a roll landing while the composer is open must re-patch
    // it (final council re-review of the deed component)
    dice: v.dice ? v.dice.join(',') : '',
    // the send row follows allowedActions (freeze gray-out)
    canTrade: v.allowed.includes('proposeTrade'),
  })
}

// A jail-card chip sits BESIDE an input inside its row: toggle the class
// in place when only the selection changed, insert/remove when presence
// changed — the input node next to it is never recreated.
function patchJailButton(row: HTMLElement | null, side: 'give' | 'recv', present: boolean, sel: boolean): void {
  if (!row) return
  const btn = row.querySelector('[data-act="composerJail"]') as HTMLElement | null
  if (btn && present) {
    btn.classList.toggle('sel', sel)
    return
  }
  if (btn && !present) {
    btn.remove()
    return
  }
  const input = row.querySelector('input[data-k]') as HTMLElement | null
  if (!btn && present && input) input.insertAdjacentHTML('afterend', composerJailHTML(side, sel))
}

// Patch every mutable region EXCEPT the inputs: chip rows and the recv
// label get innerHTML swaps, the jail buttons are re-pointed around the
// untouched input nodes. No code path here writes to an <input> — that
// is the acceptance headline, structurally.
function patchComposer(el: HTMLElement, v: PlayerView): void {
  const C = composer
  if (!C) return
  const region = (name: string): HTMLElement | null => el.querySelector(`[data-cp="${name}"]`)
  const partners = region('partners')
  if (partners) partners.innerHTML = composerPartnersRowHTML(v)
  const giveChips = region('giveChips')
  if (giveChips) giveChips.innerHTML = composerChipsHTML(v, v.you, C.giveSpaces, 'give')
  const recvChips = region('recvChips')
  if (recvChips) recvChips.innerHTML = composerChipsHTML(v, C.partner, C.recvSpaces, 'recv')
  const recvLabel = region('recvLabel')
  if (recvLabel) recvLabel.innerHTML = composerRecvLabelHTML(v)
  patchJailButton(region('giveRow'), 'give', meOf(v).jailCards > 0, C.giveJail > 0)
  patchJailButton(region('recvRow'), 'recv', (partnerPlayer(v, C.partner)?.jailCards ?? 0) > 0, C.recvJail > 0)
  const sendRow = region('sendRow')
  if (sendRow) sendRow.innerHTML = `${composerSendRowHTML(v)}<button class="big" data-act="closeTrade">Cancel</button>`
}

// ── deeds: what the grid depends on ──
// The board (owner+houses+mortgaged per space), the viewer's affordances
// (the per-card manage buttons are server-gated via allowed), the alive
// seats (owner chips), and the active filters. Anything else — a roll, a
// bid, a cash move — leaves the sheet completely untouched: scroll and
// any in-flight tap survive as-is.
function deedsSig(v: PlayerView): string {
  const props = Object.keys(v.props)
    .map(Number)
    .sort((a, b) => a - b)
    .map((i) => {
      const st = v.props[i]
      return `${i}:${st.owner ?? '-'}:${st.houses}:${st.mortgaged ? 1 : 0}`
    })
    .join(',')
  return `${props}|${v.allowed.join(',')}|${v.players.map((p) => (p.bankrupt ? '1' : '0')).join('')}|${deedFilters.owner}~${deedFilters.kind}`
}

// ── the dock (chrome-mounted, game-only) ──
// The hamburger's replacement: four permanent tools fixed to the bottom.
// It sits ABOVE sheets (z30 over z20) so Board/Deeds stay tappable
// mid-sheet — that is how you price a bid inside the 15-second window —
// and under the opaque board overlay. Everything it shows about
// affordances comes straight from allowedActions.
function updateDock(v: PlayerView | null): void {
  let el = document.getElementById('dock')
  if (!v) {
    el?.remove()
    return
  }
  if (!el) {
    const nav = document.createElement('nav')
    nav.id = 'dock'
    nav.setAttribute('aria-label', 'Game tools')
    nav.innerHTML = `
      <button class="dockbtn" data-act="showBoard" aria-label="Board">
        <span class="db-ic">🎲</span><span class="db-t">Board</span>
      </button>
      <button class="dockbtn" data-dockbtn="deeds" data-act="openDeeds" aria-label="Deeds">
        <span class="db-ic">🏠</span><span class="db-t">Deeds</span>
        <span class="dock-badge" data-dock="deedBadge"></span>
      </button>
      <button class="dockbtn" data-dockbtn="trade" data-act="openTrade" aria-label="Trade">
        <span class="db-ic">🔁</span><span class="db-t" data-dock="tradeLabel">Trade</span>
        <span class="dock-badge" data-dock="tradeBadge"></span>
      </button>
      <button class="dockbtn" data-dockbtn="more" data-act="openMore" aria-label="More">
        <span class="db-ic">⋯</span><span class="db-t">More</span>
      </button>`
    $chrome.appendChild(nav)
    el = nav
  }
  const I = meOf(v)
  const acts = new Set(v.allowed)

  // Deeds badge = your owned count
  const owned = Object.values(v.props).filter((st) => st.owner === I.id).length
  const deedBadge = el.querySelector('[data-dock="deedBadge"]') as HTMLElement | null
  if (deedBadge) {
    deedBadge.textContent = owned > 0 ? String(owned) : ''
    deedBadge.classList.toggle('zero', owned === 0)
  }

  // Trade badge = incoming offers to you
  const incoming = v.trades.filter((t) => t.to === I.id).length
  const tradeBadge = el.querySelector('[data-dock="tradeBadge"]') as HTMLElement | null
  if (tradeBadge) {
    tradeBadge.textContent = incoming > 0 ? String(incoming) : ''
    tradeBadge.classList.toggle('zero', incoming === 0)
  }

  // The Trade affordance is exactly what allowedActions says: proposing
  // is the only thing a freeze takes away, and decline/withdraw
  // deliberately survive freezes — so the button grays (with the freeze
  // reason) only while ALL THREE are off. A bankrupt seat never trades
  // again; its caption says so honestly.
  const frozenOut = !acts.has('proposeTrade') && !acts.has('respondTrade') && !acts.has('cancelTrade')
  const tradeBtn = el.querySelector('[data-dockbtn="trade"]') as HTMLButtonElement | null
  const tradeLabel = el.querySelector('[data-dock="tradeLabel"]') as HTMLElement | null
  if (tradeBtn && tradeLabel) {
    tradeBtn.disabled = frozenOut
    tradeBtn.classList.toggle('frozen', frozenOut)
    const want = frozenOut
      ? I.bankrupt || v.phase === 'GAME_OVER'
        ? 'Spectating'
        : 'Trades pause until this settles'
      : 'Trade'
    if (tradeLabel.textContent !== want) tradeLabel.textContent = want
  }

  // the active sheet's button
  const mark = (sel: string, on: boolean): void => {
    const b = el!.querySelector(sel) as HTMLElement | null
    b?.classList.toggle('on', on)
  }
  mark('[data-dockbtn="deeds"]', sheet === 'deeds')
  mark('[data-dockbtn="trade"]', sheet === 'composer')
  mark('[data-dockbtn="more"]', sheet === 'more')
}

// ── the your-move bar (chrome-mounted) ──
// The escape hatch, never a second messenger: while a sheet or the pocket
// board covers the action card AND the game waits on THIS phone, a gold
// bar says exactly what the main flow would. Tap = close the cover,
// scroll the action card into view, pulse it. The server reports exactly
// one blocking decision, so the bar never arbitrates between waits; an
// incoming trade is NOT a bar case — it rides the Trade badge.
const BAR_COPY: Record<WaitingKind, string> = {
  roll: 'YOUR MOVE — Roll the dice',
  draw: 'Draw your card',
  buy: 'Buy or send to auction',
  tax: 'Choose your tax',
  end: 'End your turn',
  jail: 'Go to jail',
  debt: 'Pay or raise the money',
  auc: 'Bid or pass',
}

function barCase(v: PlayerView): string | null {
  const w = v.waitingOn
  if (!w) return null
  const I = meOf(v)
  if (I.bankrupt) return null
  if (w.playerId === v.you) return BAR_COPY[w.kind]
  // auctions wait on the whole table: the bar shows only while THIS phone
  // can still bid or pass
  if (w.kind === 'auc' && w.playerId === null && (v.allowed.includes('bid') || v.allowed.includes('passBid'))) {
    return BAR_COPY.auc
  }
  return null
}

function updateMoveBar(v: PlayerView | null): void {
  const copy = v ? barCase(v) : null
  let el = document.getElementById('movebar') as HTMLButtonElement | null
  if (!v || !copy || (sheet == null && phoneBoard == null)) {
    el?.remove()
    return
  }
  if (!el) {
    const bar = document.createElement('button')
    bar.id = 'movebar'
    bar.dataset.act = 'barJump'
    bar.innerHTML = `<span id="barCopy">${copy}</span>${v.deadline != null ? `<span id="barCount" data-until="${v.deadline}"></span>` : ''}`
    $chrome.appendChild(bar)
    return
  }
  // patch in place — a tap in flight on the bar must land
  const copyEl = document.getElementById('barCopy') as HTMLElement | null
  if (copyEl && copyEl.textContent !== copy) copyEl.textContent = copy
  let tailEl = document.getElementById('barCount') as HTMLElement | null
  if (v.deadline != null) {
    if (!tailEl) copyEl?.insertAdjacentHTML('afterend', `<span id="barCount" data-until="${v.deadline}"></span>`)
    else if (Number(tailEl.dataset.until ?? 0) !== v.deadline) tailEl.dataset.until = String(v.deadline)
  } else if (tailEl) {
    tailEl.remove()
  }
}

// THE entry point renderGame calls after rebuilding $app. v == null (no
// game view) tears the dock, the bar and every sheet down — the game-only
// chrome dies with the game view.
function updateChrome(v: PlayerView | null): void {
  // a dying game view must never leave a locked body or a stale sheet
  if (v == null && sheet) {
    sheet = null
    sheetFocusSaved = null
    delete document.body.dataset.sheet
  }
  // defensive: a composer sheet without draft data is nothing at all
  if (v != null && sheet === 'composer' && composer == null) sheet = null
  updateDock(v)

  for (const kind of SHEET_KINDS) {
    const el = document.getElementById(SHEET_IDS[kind])
    const wanted = v != null && sheet === kind && (kind !== 'composer' || composer != null)
    if (!wanted) {
      if (el) {
        el.remove()
        if (kind === 'composer') composerSigLast = ''
        if (kind === 'deeds') deedsSigLast = ''
      }
      continue
    }
    const vv = v as PlayerView
    if (!el) {
      mountSheet(SHEET_IDS[kind], SHEET_CLASSES[kind], sheetHTMLFor(kind, vv), SHEET_CLOSE_ACTS[kind], SHEET_LABELS[kind])
      if (kind === 'composer') composerSigLast = composerSig(vv)
      if (kind === 'deeds') deedsSigLast = deedsSig(vv)
    } else if (kind === 'deeds') {
      const sig = deedsSig(vv)
      if (sig !== deedsSigLast) {
        // the board, the affordances or the filters actually changed: one
        // re-emit of the sheet content (badges, owner labels and the head
        // count are all derived from that same signature)
        const sh = el.querySelector('.sheet') as HTMLElement
        sh.innerHTML = deedsSheetHTML(vv)
        deedsSigLast = sig
      }
      // sig unchanged → the grid (and its scroll) is left completely alone
    } else if (kind === 'composer') {
      const sig = composerSig(vv)
      if (sig !== composerSigLast) {
        patchComposer(el, vv)
        composerSigLast = sig
      }
      // sig unchanged → zero DOM writes: focus, caret and text untouched
    } else {
      patchMore(el)
    }
  }

  updateMoveBar(v)
}

// First paint: never leave the phone blank while the socket warms up.
render()
