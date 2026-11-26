// ── Phone controller ──
// Your wallet, your properties, your decisions — plus the full transaction
// ledger for every player. The server tells us what we're allowed to do
// (PlayerView.allowed) and the shared rules helpers give per-property
// affordances. Card spaces are interactive: open the chest / spin the wheel,
// and the reveal animates here and on the TV.

import { io } from 'socket.io-client'
import { BOARD, GROUP_COLORS, groupIndices, isStreet } from '../../shared/board.js'
import { TOKENS, stripEmoji } from '../../shared/tokens.js'
import { COLORS } from '../../shared/colors.js'
import { AvatarPreview, avatarThumbnail } from '../tokens3d.js'
import { Board3D } from '../host/board3d.js'
import { startUpdater } from '../version-check.js'
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
import type { Action, Card, ColorGroup, LobbyInfo, PlayerView, Space, TradeOffer, TradeSide } from '../../shared/types.js'

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

let view: PlayerView | null = null
let lobby: LobbyInfo | null = null
let myName = ''
let myToken: string | null = localStorage.getItem('mp-token')
let myPlayerId: string | null = localStorage.getItem('mp-playerid')

// Trade composer state survives re-renders (views arrive after every action).
interface Composer {
  open: boolean
  partner: string
  giveCash: number
  giveSpaces: number[]
  giveJail: number
  recvCash: number
  recvSpaces: number[]
  recvJail: number
}
let composer: Composer | null = null

// Hamburger menu + View-properties screen are module-level UI state, re-emitted
// inside $app on every render (composer precedent) so they survive view pushes.
let menuOpen = false
let deedsOpen = false
// Deed grid filters: owner is 'ALL' | 'UNOWNED' | a playerId; kind is 'ALL' |
// a color-group key | 'rail' | 'utility'. Both single-select, AND-combined.
let deedFilters = { owner: 'ALL' as string, kind: 'ALL' as string }
const GROUP_ORDER: ColorGroup[] = ['brown', 'lightblue', 'pink', 'orange', 'red', 'yellow', 'green', 'blue']
const GROUP_LABEL: Record<ColorGroup, string> = {
  brown: 'Brown', lightblue: 'Light blue', pink: 'Pink', orange: 'Orange',
  red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue',
}

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

function stripColorPhone(sp: Space): string {
  if (isStreet(sp)) return GROUP_COLORS[sp.group]
  if (sp.kind === 'rail') return '#4b5563'
  if (sp.kind === 'utility') return '#6b7280'
  if (sp.kind === 'chance') return '#c2410c'
  if (sp.kind === 'chest') return '#0e7490'
  return '#9aa1ad'
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

// Deadline chip ticker — updates the countdown in place so a running
// timer never re-renders (and never steals focus from inputs).
setInterval(() => {
  const el = document.getElementById('deadlineChip') as HTMLElement | null
  if (!el) return
  const until = Number(el.dataset.until ?? 0)
  const rem = Math.max(0, Math.ceil((until - Date.now()) / 1000))
  const span = el.querySelector('span')
  if (span) span.textContent = `${rem}s`
  el.classList.toggle('urgent', rem <= 10)
}, 250)

// ── card reveal overlay (chest opens / wheel spins) ──

function showReveal(card: Card): void {
  const isChest = card.deck === 'chest'
  const overlay = document.createElement('div')
  overlay.className = 'reveal-overlay'
  overlay.innerHTML = `
    <div class="reveal-box">
      <div class="reveal-title">${isChest ? 'COMMUNITY CHEST' : 'CHANCE'}</div>
      ${isChest
        ? '<div class="chestwrap"><div class="chestlid"></div><div class="chestlock"></div><div class="chestbase"></div></div>'
        : '<div class="wheelwrap"><div class="wheeldisc"></div><div class="wheelhub"></div><div class="wheelpointer"></div></div>'}
      <div class="revealcard ${isChest ? 'chest-card' : 'chance-card'}">${esc(card.text)}</div>
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
// sheet must not greet the join screen.
function resetScreenStates(): void {
  menuOpen = false
  deedsOpen = false
  deedFilters = { owner: 'ALL', kind: 'ALL' }
  rollSeen = false
  rollKey = ''
  rollPrevHadDice = false
  rollPrevPhase = ''
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
// suspense beat: the dice tumble for the TV's 1150ms hold, settle on the
// real values, and only then does the landing underneath get revealed.
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
  const roller = v.players.find((p) => p.id === v.currentPlayerId)
  const mine = v.currentPlayerId === v.you
  const d1 = v.dice?.[0] ?? 1
  const d2 = v.dice?.[1] ?? 1
  const overlay = document.createElement('div')
  overlay.className = 'roll-overlay'
  overlay.innerHTML = `
    <div class="roll-box${mine ? ' mine' : ''}">
      <div class="roll-who">${mine ? 'You roll!' : `${avathumb(roller)}${esc(roller?.name ?? 'Someone')} rolls`}</div>
      <div class="dice-row">
        <div class="die tumbling"></div>
        <div class="die tumbling"></div>
      </div>
      <div class="roll-total"></div>
    </div>`
  document.body.appendChild(overlay)
  const [dieA, dieB] = [...overlay.querySelectorAll('.die')] as HTMLElement[]
  const total = overlay.querySelector('.roll-total') as HTMLElement

  // tumbling faces, swapping fast — the anticipation phase
  const tumbler = setInterval(() => {
    dieA.innerHTML = pipsFor(1 + Math.floor(Math.random() * 6))
    dieB.innerHTML = pipsFor(1 + Math.floor(Math.random() * 6))
  }, 90)

  // the TV's dice hold is 1150ms; settle when it does
  setTimeout(() => {
    clearInterval(tumbler)
    dieA.innerHTML = pipsFor(d1)
    dieB.innerHTML = pipsFor(d2)
    dieA.classList.remove('tumbling')
    dieB.classList.remove('tumbling')
    dieA.classList.add('settled')
    dieB.classList.add('settled')
    total.textContent = `${d1} + ${d2} = ${d1 + d2}${d1 === d2 ? ' — DOUBLES!' : ''}`
  }, 1150)
  // the piece on the TV has (mostly) arrived by now — show the landing
  setTimeout(() => overlay.remove(), 2600)
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
let phoneBoard: Board3D | null = null

// One-time discovery: playtesters never found the Board button, so
// the first game view gets a full-width promo above the action cards.
// Opening the board (promo or menu) retires it forever, per browser.
const BOARD_PROMO_FLAG = 'mp-board-promo'
// Persisted single-finger gesture verb for the pocket board: 'pan' (map-style
// lateral drag, the default) or 'orbit'. Stored per browser.
const GESTURE_FLAG = 'mp-board-gesture'
type GestureMode = 'pan' | 'orbit'
const gestureLabel = (m: GestureMode): string => (m === 'pan' ? '✋ Pan' : '🔄 Orbit')

function showBoard(): void {
  if (!view) return
  localStorage.setItem(BOARD_PROMO_FLAG, '1')
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
// ONE deed renderer, reused by the View-properties grid, the pocket-board
// tap, the table deed chips and the trade strips: the full rent ladder,
// what it earns right now (● now), mortgage math, and the owner. Cards are
// pure display — never a button. Management buttons ride along only in the
// grid (actions:true) and only from manageButtons, the same acts.has +
// can* gate renderPortfolio uses, so the two can never drift.
function deedCardHTML(v: PlayerView, space: number, opts: { actions: boolean }): string {
  const sp: Space = BOARD[space]
  const st = v.props[space]
  const owner = st && st.owner ? v.players.find((p) => p.id === st.owner) : null
  const hasPrice = 'price' in sp
  const rp = hasPrice ? rentPreview(v, space) : null
  const strip = stripColorPhone(sp)
  const row = (label: string, val: string, now: boolean): string =>
    `<div class="dc-row${now ? ' now' : ''}"><span class="dc-l">${label}</span><span class="dc-v">${val}</span>${now ? '<span class="dc-now">● now</span>' : ''}</div>`

  let badges = ''
  if (st?.mortgaged) badges += '<span class="dc-badge">MORTGAGED</span>'
  if (isStreet(sp) && st && st.houses === 5 && rp) badges += `<span class="dc-badge">HOTEL · rent $${rp.current}</span>`
  // kept from the old propinfo card: the mortgage hint sits under the badge
  const hint = st?.mortgaged ? '<div class="dc-hint">mortgaged — earns nothing while asleep</div>' : ''

  // A mortgaged deed earns nothing — the ● now markers must stay dark even
  // though rentPreview ignores the mortgage flag (council re-review, defa52b
  // round). The doubled-rent parenthetical is not a live claim, so it keeps
  // plain `owner`.
  const liveOwner = owner && !st?.mortgaged
  // ── rent ladder ──
  let ladder = ''
  if (isStreet(sp) && st && rp) {
    // hotel row is skipped from the ladder — the badge above carries it
    const tiers = [
      { label: '1 house', val: sp.rents[1] },
      { label: '2 houses', val: sp.rents[2] },
      { label: '3 houses', val: sp.rents[3] },
      { label: '4 houses', val: sp.rents[4] },
    ]
    let rentVal = `$${sp.rents[0]}`
    if (owner && st.houses === 0 && rp.note === 'full set — doubled') {
      // mirror rentPreview's semantics: the Rent row carries the doubled
      // value in parens, marked ● now
      rentVal = `$${sp.rents[0]} ($${sp.rents[0] * 2})`
    }
    const nowIdx = liveOwner && st.houses < 5 ? st.houses : -1 // 0 = the Rent row
    ladder =
      row('Rent', rentVal, nowIdx === 0) +
      tiers.map((t, k) => row(t.label, `$${t.val}`, k + 1 === nowIdx)).join('')
    ladder += row('Mortgage value', `$${sp.price / 2}`, false)
    ladder += row('House cost', `$${sp.houseCost} each`, false)
  } else if (sp.kind === 'rail' && rp) {
    // ● now on the owner's railroad count, read off rentPreview's note
    const m = /(\d+)/.exec(rp.note)
    const count = liveOwner && m ? Number(m[1]) : -1
    ladder = [25, 50, 100, 200].map((val, k) => row(`${k + 1} railroad${k ? 's' : ''}`, `$${val}`, k + 1 === count)).join('')
    ladder += row('Mortgage value', `$${'price' in sp ? sp.price / 2 : 100}`, false)
    ladder += row('No houses', '', false)
  } else if (sp.kind === 'utility' && rp) {
    // ● now on the live dice multiplier (rentPreview's current is 4 or 10)
    const live = liveOwner ? rp.current : -1
    ladder = row('With 1 utility', '4× dice', live === 4) + row('With both', '10× dice', live === 10)
    ladder += row('Mortgage value', `$${'price' in sp ? sp.price / 2 : 75}`, false)
    ladder += row('No houses', '', false)
  }

  const foot = hasPrice
    ? `<div class="dc-foot">${owner ? `${avathumb(owner)}<b style="color:${owner.color}">${esc(owner.name)}</b>` : '<span class="dc-bank">Bank · unowned</span>'}<span class="dc-price">Price $${'price' in sp ? sp.price : 0}</span></div>`
    : '<div class="dc-foot"><span class="dc-bank">Not for sale</span></div>'

  let actions = ''
  if (opts.actions && hasPrice) {
    const btns = manageButtons(v, v.you, space)
    if (btns.length > 0) actions = `<div class="dc-actions row">${btns.join('')}</div>`
  }
  return `<div class="deed-card" style="--g:${strip}">
    <div class="dc-head${isStreet(sp) && sp.group === 'yellow' ? ' dark' : ''}">${esc(sp.name)}${badges}</div>
    ${hint}
    ${ladder ? `<div class="dc-ladder">${ladder}</div>` : ''}
    ${foot}
    ${actions}
  </div>`
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
// trade strips: every path lands on the same title-deed layout, no
// management buttons here (ruled) — just the card and a Close row.
function showPropInfo(space: number): void {
  const v = view
  if (!v) return
  document.querySelector('.propinfo-overlay')?.remove()
  const overlay = document.createElement('div')
  overlay.className = 'propinfo-overlay'
  overlay.innerHTML = `
    <div class="propinfo-card">
      ${deedCardHTML(v, space, { actions: false })}
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
  if (dingArmed && key.length > 0 && key !== prevAllowedKey) ding()
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
  menuOpen = false
  deedsOpen = false
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
  // view pushes DURING the game re-emit them, so they survive updates
  if (enteringGame) {
    menuOpen = false
    deedsOpen = false
    deedFilters = { owner: 'ALL', kind: 'ALL' }
  }

  // fresh card draw? the chest-opening / wheel-spinning animation plays ONLY on
  // the drawer's phone; everyone else reads the info strip instead
  if (v.cardDrawSeq > lastCardSeq && lastCardSeq >= 0 && v.pendingCard && v.currentPlayerId === v.you) {
    showReveal(v.pendingCard)
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
    case 'theme':
      menuOpen = false // theme rides the menu sheet: close it before dispatch
      theme = theme === 'light' ? 'dark' : 'light'
      localStorage.setItem('mp-theme', theme)
      document.documentElement.dataset.theme = theme
      render()
      break
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
      // Both exits (lobby "Leave room" and the menu's "Leave the game")
      // start the same two-step confirmation — see showExitConfirm. From
      // the menu the sheet must be torn down FIRST, or it lingers (dead,
      // screen-blocking) under the confirm overlay's step-1 backdrop.
      if (menuOpen) {
        menuOpen = false
        render()
      }
      showExitConfirm(1)
      break
    }
    case 'propInfo': {
      showPropInfo(Number(args.space))
      break
    }
    case 'showBoard': {
      menuOpen = false // showBoard re-renders through closeBoard — the sheet dies with it
      showBoard()
      break
    }
    case 'menu': {
      menuOpen = !menuOpen
      render()
      break
    }
    case 'closeMenu': {
      menuOpen = false
      render()
      break
    }
    case 'openDeeds': {
      // fresh defaults every open (table rows pass their player as owner)
      deedFilters = { owner: args.owner ? String(args.owner) : 'ALL', kind: 'ALL' }
      deedsOpen = true
      menuOpen = false
      render()
      break
    }
    case 'closeDeeds': deedsOpen = false; render(); break
    case 'deedOwner': {
      const owner = String(args.owner)
      deedFilters = { ...deedFilters, owner: deedFilters.owner === owner ? 'ALL' : owner }
      render()
      break
    }
    case 'deedKind': {
      const kind = String(args.kind)
      deedFilters = { ...deedFilters, kind: deedFilters.kind === kind ? 'ALL' : kind }
      render()
      break
    }
    case 'deedClearFilters':
      deedFilters = { owner: 'ALL', kind: 'ALL' }
      render()
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
      const partners = v.players.filter((p) => !p.bankrupt && p.id !== v.you)
      if (partners.length === 0) return toast('Nobody to trade with!')
      composer = {
        open: true,
        partner: String(args.partner ?? partners[0]?.id ?? ''),
        giveCash: 0, giveSpaces: [], giveJail: 0,
        recvCash: 0, recvSpaces: [], recvJail: 0,
      }
      render()
      break
    }
    case 'closeTrade': composer = null; render(); break
    case 'sendTrade': {
      if (!composer) return
      const give: TradeSide = { cash: Math.max(0, Math.floor(composer.giveCash)), spaces: composer.giveSpaces, jailCards: composer.giveJail }
      const receive: TradeSide = { cash: Math.max(0, Math.floor(composer.recvCash)), spaces: composer.recvSpaces, jailCards: composer.recvJail }
      if (give.cash === 0 && give.spaces.length === 0 && give.jailCards === 0 && receive.cash === 0 && receive.spaces.length === 0 && receive.jailCards === 0) {
        return toast('Offer something!')
      }
      send({ type: 'proposeTrade', to: composer.partner, give, receive })
      composer = null
      render()
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

  // First game view on this browser: one promo teaches that the whole 3D
  // board is in your pocket. Above the action cards, retired on first open.
  if (!localStorage.getItem(BOARD_PROMO_FLAG)) {
    body += `<button class="big wide boardpromo" data-act="showBoard">🎲 See the whole board — pinch to zoom, drag to pan</button>`
  }

  // What the active player drew — an info strip, NEVER a blocker: the action
  // cascade below must always render so the game can always advance.
  let drawStrip = ''
  if (v.pendingCard && !v.pendingCardDraw) {
    const deckName = v.pendingCard.deck === 'chest' ? 'Community Chest' : 'Chance'
    drawStrip = `<div class="drawstrip"><b>${deckName}</b> said: ${esc(v.pendingCard.text)}</div>`
  }

  // What the active player just landed on, in its group color — visible on
  // every phone so the table shares one mental model of the board.
  let landedStrip = ''
  if (v.lastLanded && v.lastLanded.playerId === v.currentPlayerId) {
    const i = v.lastLanded.space
    const sp = BOARD[i]
    const col = stripColorPhone(sp)
    const drawer = v.players.find((p) => p.id === v.currentPlayerId)
    const who = I.id === v.currentPlayerId ? 'You' : `${avathumb(drawer)}${esc(drawer?.name ?? '')}`
    // rent line: what landing here is worth right now (or would be)
    let rentLine = ''
    if ('price' in sp) {
      const rp = rentPreview(v, i)
      const owner = v.props[i].owner ? v.players.find((p) => p.id === v.props[i].owner) : null
      if (owner && owner.id === v.currentPlayerId) {
        // the mover landed on their own property — only THEIR phone says
        // "Yours"; everyone else sees who's earning.
        rentLine = owner.id === I.id
          ? `<span class="ls-rent">Yours — earns <b>$${rp.current}</b>${sp.kind === 'utility' ? ` (${rp.note})` : ''}</span>`
          : `<span class="ls-rent">${avathumb(owner)}${esc(owner.name)} - earns <b>$${rp.current}</b>${sp.kind === 'utility' ? ` (${rp.note})` : ''}</span>`
      } else if (owner) {
        // someone else's property — if it's MINE, the rent is mine to collect
        const who = owner.id === I.id ? '<b>yours to collect</b>' : `${avathumb(owner)}${esc(owner.name)}`
        const diceSum = v.dice ? v.dice[0] + v.dice[1] : 7
        rentLine = `<span class="ls-rent">Rent due: <b>$${rentFor(v, i, diceSum)}</b> — ${who}</span>`
      } else {
        rentLine = `<span class="ls-rent">Rent: <b>$${rp.current}</b> when owned${sp.kind === 'utility' ? ` (${rp.note})` : ''}</span>`
      }
    }
    landedStrip = `<div class="landedstrip" style="--g:${col}">
      <span class="ls-swatch"></span>
      <span class="ls-text">${who} landed on <b>${esc(sp.name)}</b>${'price' in sp ? ` · $${sp.price}` : ''}${isStreet(sp) ? ` <span class="ls-group">${sp.group.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}</span>` : ''}${rentLine}</span>
    </div>`
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
    // one phrase for every kind of charge, straight off the memo the server
    // put on the debt — no per-card parsing here.
    const blurb = debtBlurb(v.debt)
    banner = `<div class="banner debt">You owe <b>$${v.debt.amount}</b> to ${creditor ? `${avathumb(creditor)}${esc(creditor.name)}` : 'the bank'} — ${esc(blurb)}</div>`
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
    const blurb = debtBlurb(v.debt)
    // A relay card queues several payments through one freeze. If I'M the one
    // getting paid, show how much of the relay is still owed to me.
    const dq = v.debtQueue || []
    let relay = ''
    if (v.debt.creditor === I.id && dq.some((d) => d.creditor === I.id)) {
      const mine = 1 + dq.filter((d) => d.creditor === I.id).length
      relay = ` — <b>${mine} of ${1 + dq.length} still to pay</b>`
    }
    banner = `<div class="banner info">${avathumb(debtor)}${esc(debtor?.name ?? '')} is paying ${creditor ? `${avathumb(creditor)}${esc(creditor.name)}` : 'the bank'} <b>$${v.debt.amount}</b> — ${esc(blurb)}${relay}</div>`
  } else if (v.phase === 'AUCTION' && v.auction) {
    const sp = BOARD[v.auction.space]
    const bidder = v.players.find((p) => p.id === v.auction?.bidder)
    const mine = v.auction.bidder === I.id
    banner = `<div class="banner auction">Auction: <b>${esc(sp.name)}</b> — $${v.auction.bid}${bidder ? ` (${esc(bidder.name)})` : ''}</div>`
    if (mine) {
      body += `<div class="card"><h3>You're the high bidder</h3><p class="hint">Waiting for the others…</p></div>`
    } else if (acts.has('bid') || acts.has('passBid')) {
      const au = v.auction
      const min = au.bid + 1
      const highBidder = au.bidder ? v.players.find((p) => p.id === au.bidder) : null
      body += `
        <div class="card">
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
    banner = `<div class="banner info">${cur ? esc(cur.name) : 'The active player'} landed on ${v.pendingCardDraw.deck === 'chest' ? 'Community Chest' : 'Chance'} — waiting for the reveal…</div>`
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
    banner = `<div class="banner info">${avathumb(arrested)}${esc(arrested?.name ?? '')} is under arrest — waiting for them to go to jail…</div>`
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
      const rp = rentPreview(v, v.pendingPurchase)
      const rentNote = sp.kind === 'utility' ? ` (${rp.note})` : ''
      banner = `<div class="banner good">You landed on <b>${esc(sp.name)}</b></div>`
      body += `<div class="card actions">
        <h3>Unowned — $${price}</h3>
        <p class="hint">Rent when owned: <b>$${rp.current}${rentNote}</b>${isStreet(sp) ? ` · next tier $${rp.next}` : ''}</p>
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
  } else {
    banner = `<div class="banner info">${cur ? `${avathumb(cur)}<b>${esc(cur.name)}</b>'s turn` : 'Waiting…'}</div>`
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

  // ── My portfolio ──
  body += renderPortfolio(v, I.id)

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
      <button class="menubtn" data-act="menu" aria-label="Menu" aria-expanded="${menuOpen}">☰</button>
    </header>
    ${banner}
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

function sideSummary(side: TradeSide): string {
  const parts: string[] = []
  if (side.cash > 0) parts.push(`$${side.cash}`)
  for (const i of side.spaces) {
    const col = stripColorPhone(BOARD[i])
    parts.push(
      `<span class="tradestrip" style="background:${col}"></span><button type="button" class="linkbtn" data-act="propInfo" data-args='{"space":${i}}'>${esc(BOARD[i].name)}</button>`,
    )
  }
  if (side.jailCards > 0) parts.push(`jail card ×${side.jailCards}`)
  return parts.join(' + ') || 'nothing'
}

function tradeCard(v: PlayerView, t: TradeOffer, dir: 'incoming' | 'outgoing'): string {
  const from = v.players.find((p) => p.id === t.from)
  const to = v.players.find((p) => p.id === t.to)
  // Accepting moves money and deeds, so it waits out auction/debt freezes
  // (the engine enforces the same rule). Declining or withdrawing is
  // always live — the engine takes it in any phase.
  const frozen = v.phase === 'AUCTION' || v.phase === 'DEBT'
  return `<div class="card trade">
    <div><b>${avathumb(from)}${esc(from?.name ?? '')}</b> offers <b>${sideSummary(t.give)}</b><br/>in exchange for <b>${sideSummary(t.receive)}</b> <span class="hint">(${esc(to?.name ?? '')})</span></div>
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
  const rows = owned
    .map(({ i, st }) => {
      const sp: Space = BOARD[i]
      const strip = isStreet(sp) ? `<span class="strip" style="background:${GROUP_COLORS[sp.group]}"></span>` : `<span class="strip gray"></span>`
      const marks =
        (st.houses > 0 ? (st.houses === 5 ? 'hotel' : `${st.houses} house${st.houses > 1 ? 's' : ''}`) : '') +
        (st.mortgaged ? ' · mortgaged' : '')
      // earning line: what it earns now, and what the next build tier earns
      const rp = rentPreview(v, i)
      let earn = ''
      if (isStreet(sp)) {
        earn = st.houses === 5
          ? `earns $${rp.current} (hotel)`
          : rp.next != null
            ? `earns $${rp.current} → <b>$${rp.next}</b> with ${rp.next === sp.rents[5] ? 'a hotel' : 'a house'}${rp.note ? ` · ${rp.note}` : ''}`
            : `earns $${rp.current}${rp.note ? ` · ${rp.note}` : ''}`
      } else if (sp.kind === 'rail') {
        earn = `earns $${rp.current} (${rp.note})${rp.next != null ? ` → <b>$${rp.next}</b> with another railroad` : ''}`
      } else if (sp.kind === 'utility') {
        earn = `earns ${rp.note}${rp.next != null ? ` → <b>${rp.next}× dice</b> with both` : ''}`
      }
      if (st.mortgaged) earn = 'mortgaged — no rent while asleep'
      // The server's allowed list is THE gate: a button renders exactly when
      // the engine would accept it (manageButtons — shared with the deeds
      // grid, so the two can never drift). During freezes (auction/debt) the
      // list omits management actions, so the buttons simply don't appear —
      // the phase banner already explains what the table is waiting on.
      const btns = manageButtons(v, pid, i)
      return `<div class="prop">
        ${strip}
        <div class="pinfo">
          <div class="pname">${esc(sp.name)}${marks ? ` <span class="hint">${marks}</span>` : ''}</div>
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
        .map((i) => {
          const sp = BOARD[i]
          const col = isStreet(sp) ? GROUP_COLORS[sp.group] : '#9aa1ad'
          return `<button class="deedchip" style="--g:${col}" data-act="propInfo" data-args='{"space":${i}}'><span class="dstrip"></span>${esc(abbrName(sp))}</button>`
        })
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
  const chip = (i: number, sel: boolean): string => {
    const sp = BOARD[i]
    const col = isStreet(sp) ? GROUP_COLORS[sp.group] : '#9aa1ad'
    return `<button class="chip ${sel ? 'sel' : ''}" style="border-color:${col}" data-act="${which === 'give' ? 'toggleGiveSpace' : 'toggleRecvSpace'}" data-args='{"space":${i}}'>${esc(sp.name)}</button>`
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
      <div class="row">
        <button class="big primary" data-act="sendTrade">Send offer</button>
        <button class="big" data-act="closeTrade">Cancel</button>
      </div>`
}

// ── the hamburger sheet (chrome-mounted) ──
// The topbar's three utility buttons live behind one ☰. Sheet content
// only — mountSheet wraps it; patchMenu patches just the theme label.
function menuSheetHTML(): string {
  return `
        <button class="menu-item" data-act="showBoard">
          <span class="mi-label">🎲 Pocket board</span>
          <span class="mi-hint">Pinch to zoom · drag to pan (or orbit)</span>
        </button>
        <button class="menu-item" data-act="openDeeds">
          <span class="mi-label">🏠 View properties</span>
          <span class="mi-hint">Every title deed, all owners</span>
        </button>
        <button class="menu-item" data-act="theme">
          <span class="mi-label" data-mi="theme">${theme === 'light' ? '🌙 Dark theme' : '☀️ Light theme'}</span>
          <span class="mi-hint">Switch the look of this phone</span>
        </button>
        <div class="menu-sep"></div>
        <button class="menu-item danger" data-act="leave">
          <span class="mi-label">Leave the game</span>
        </button>`
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
    `<button class="chip ${deedFilters.kind === 'rail' ? 'sel' : ''}" style="--g:#4b5563" data-act="deedKind" data-args='{"kind":"rail"}'><span class="dstrip"></span>Railroads</button>`,
    `<button class="chip ${deedFilters.kind === 'utility' ? 'sel' : ''}" style="--g:#6b7280" data-act="deedKind" data-args='{"kind":"utility"}'><span class="dstrip"></span>Utilities</button>`,
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
          `<div class="deed-h">${esc(b.heading)}</div><div class="deedgrid">${b.items
            .map((i) => deedCardHTML(v, i, { actions: true }))
            .join('')}</div>`,
      )
      .join('')
  } else {
    grid = `<div class="deedgrid">${matches.map((i) => deedCardHTML(v, i, { actions: true })).join('')}</div>`
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
// sibling: the three sheets. Each mounts once per open and is then
// patched, never rebuilt with the main flow — a push mid-typing never
// touches the composer's inputs (focus and contents survive), and the
// deeds grid is left byte-identical (scroll intact) unless the board
// actually changed. Transient momentary overlays (card reveal, dice,
// confirms, GO, the pocket board, propinfo, toasts, the update pill) stay
// body-level and untouched. Sheet visibility is still the existing module
// flags (menuOpen / deedsOpen / composer.open): mount on open, unmount on
// close. The single-sheet state machine is a later round — not built here.

// Signatures of the last-applied patch, so unchanged pushes cost zero
// DOM writes (and the deeds grid's scrollTop survives them untouched).
let composerSigLast = ''
let deedsSigLast = ''

// Backdrop tap closes (data-act on .modal); the sheet swallows taps with
// an empty data-act — the composer's shield, unchanged.
function mountSheet(id: string, sheetClass: string, sheetHTML: string, backdropAct: string): HTMLElement {
  const modal = document.createElement('div')
  modal.className = 'modal'
  modal.id = id
  modal.dataset.act = backdropAct
  modal.innerHTML = `<div class="sheet ${sheetClass}" data-act="">${sheetHTML}</div>`
  $chrome.appendChild(modal)
  return modal
}

// ── menu: fully static except the theme label — patch exactly that ──
function patchMenu(el: HTMLElement): void {
  const label = el.querySelector('[data-mi="theme"]') as HTMLElement | null
  if (!label) return
  const want = theme === 'light' ? '🌙 Dark theme' : '☀️ Light theme'
  if (label.textContent !== want) label.textContent = want
}

// ── composer: what its chip regions depend on ──
// The cash INPUTS are deliberately absent from this signature — typing
// changes composer.giveCash/recvCash only, so a push mid-typing finds the
// signature unchanged and performs ZERO DOM writes on the sheet.
function composerSig(v: PlayerView): string {
  const C = composer
  if (!C) return ''
  const partner = partnerPlayer(v, C.partner)
  const spacesOf = (pid: string): number[] => Object.entries(v.props).filter(([, st]) => st.owner === pid).map(([i]) => Number(i))
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

// THE entry point renderGame calls after rebuilding $app. v == null (no
// game view) tears every sheet down — the game-only sheets die with the
// game view, exactly as they did when they lived inside $app.
function updateChrome(v: PlayerView | null): void {
  // menu sheet
  const menuEl = document.getElementById('chromeMenu')
  if (v && menuOpen) {
    if (!menuEl) mountSheet('chromeMenu', 'menu-sheet', menuSheetHTML(), 'closeMenu')
    else patchMenu(menuEl)
  } else if (menuEl) menuEl.remove()

  // trade composer
  const composerEl = document.getElementById('chromeComposer')
  if (v && composer && composer.open) {
    const sig = composerSig(v)
    if (!composerEl) {
      mountSheet('chromeComposer', '', composerSheetHTML(v), 'closeTrade')
      composerSigLast = sig
    } else if (sig !== composerSigLast) {
      patchComposer(composerEl, v)
      composerSigLast = sig
    }
    // sig unchanged → zero DOM writes: focus, caret and text untouched
  } else if (composerEl) {
    composerEl.remove()
    composerSigLast = ''
  }

  // deeds library
  const deedsEl = document.getElementById('chromeDeeds')
  if (v && deedsOpen) {
    const sig = deedsSig(v)
    if (!deedsEl) {
      mountSheet('chromeDeeds', 'deeds-sheet', deedsSheetHTML(v), 'closeDeeds')
      deedsSigLast = sig
    } else if (sig !== deedsSigLast) {
      // the board, the affordances or the filters actually changed: one
      // re-emit of the sheet content (badges, owner labels and the head
      // count are all derived from that same signature)
      const sheet = deedsEl.querySelector('.sheet') as HTMLElement
      sheet.innerHTML = deedsSheetHTML(v)
      deedsSigLast = sig
    }
    // sig unchanged → the grid (and its scroll) is left completely alone
  } else if (deedsEl) {
    deedsEl.remove()
    deedsSigLast = ''
  }
}

// First paint: never leave the phone blank while the socket warms up.
render()
