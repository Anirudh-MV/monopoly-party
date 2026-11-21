// ── Phone controller ──
// Your wallet, your properties, your decisions — plus the full transaction
// ledger for every player. The server tells us what we're allowed to do
// (PlayerView.allowed) and the shared rules helpers give per-property
// affordances. Card spaces are interactive: open the chest / spin the wheel,
// and the reveal animates here and on the TV.

import { io } from 'socket.io-client'
import { BOARD, GROUP_COLORS, isStreet } from '../../shared/board.js'
import { TOKENS, stripEmoji } from '../../shared/tokens.js'
import { AvatarPreview } from '../tokens3d.js'
import { Board3D } from '../host/board3d.js'
import {
  canBuildOn,
  canMortgageOn,
  canSellHouseOn,
  canUnmortgageOn,
  netWorth,
  rentFor,
  rentPreview,
  unmortgageCost,
} from '../../shared/rules.js'
import type { Action, Card, LobbyInfo, PlayerView, Space, TradeOffer, TradeSide } from '../../shared/types.js'

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
const PREVIEW_COLOR = '#f59e0b'
// optimistic piece selection in the lobby (cleared once the broadcast lands)
let lobbySel: string | null = null

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
// the seat stays at the table but the rejoin token dies — this phone can
// never come back to that room. So it takes TWO separate confirmations,
// with different wording each step so neither can be muscle-memoryed.
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
            ? 'You\u2019ll go back to the join screen and can enter a different room code. Your seat stays at the table, and this phone won\u2019t be able to rejoin this room.'
            : 'You\u2019ll go back to the join screen and can enter a different room code.'
          : inGame
            ? 'Really leave? This phone can never rejoin the game you\u2019re in.'
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
  socket.emit('room:leave', {}, () => {
    localStorage.removeItem('mp-token')
    localStorage.removeItem('mp-playerid')
    myToken = null
    myPlayerId = null
    lobby = null
    view = null
    composer = null
    lastCardSeq = -1
    render()
  })
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

// ── the dice roll moment ──
// Every phone at the table plays the roll together, in sync with the TV's
// suspense beat: the dice tumble for the TV's 1150ms hold, settle on the
// real values, and only then does the landing underneath get revealed.
let lastRollKey = ''
let firstRollSeen = false

function maybeShowRoll(v: PlayerView): void {
  if (!v.dice) return
  const key = `${v.turn}:${v.currentPlayerId}:${v.dice.join()}`
  if (key === lastRollKey) return
  lastRollKey = key
  if (!firstRollSeen) {
    firstRollSeen = true
    return // reconnect mid-turn: don't replay a roll that already happened
  }
  showRollOverlay(v)
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
    <div class="roll-box">
      <div class="roll-who">${mine ? 'You roll!' : `${roller?.token ?? ''} ${esc(roller?.name ?? 'Someone')} rolls`}</div>
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

function showBoard(): void {
  if (!view) return
  closeBoard()
  const overlay = document.createElement('div')
  overlay.className = 'board-overlay'
  overlay.innerHTML = `
    <div class="board-tools">
      <button class="board-tool" data-act="boardReset">⟲ Reset view</button>
      <button class="board-tool" data-act="boardFollow">▶ Follow game</button>
      <button class="board-tool board-closebtn" data-act="boardClose">✕ Close</button>
    </div>`
  document.body.appendChild(overlay)
  phoneBoard = new Board3D(overlay)
  phoneBoard.setTheme(theme)
  phoneBoard.setRoam(true) // free roaming — the camera is the player's
  phoneBoard.sync(view)
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

const preCode = (new URLSearchParams(location.search).get('code') ?? '').toUpperCase()

// True while a stored rejoin token is being checked — show a connecting card
// instead of flashing the join form at a returning player.
let rejoinPending = myToken != null

// Fires on the FIRST connect and on every automatic reconnect (Wi-Fi blip,
// screen lock, server restart). The stored token reattaches the seat —
// wallet, deeds and jail cards intact. This is the seamless-rejoin path.
const socket = io()
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
  render()
})

// The party host removed this seat — back to the join screen, politely.
socket.on('kicked', () => {
  localStorage.removeItem('mp-token')
  localStorage.removeItem('mp-playerid')
  myToken = null
  myPlayerId = null
  lobby = null
  view = null
  composer = null
  lobbySel = null
  render()
  toast('The host removed you from the room')
})

socket.on('view', (v: PlayerView) => {
  view = v
  lobby = null
  rejoinPending = false

  // fresh card draw? the chest-opening / wheel-spinning animation plays ONLY on
  // the drawer's phone; everyone else reads the info strip instead
  if (v.cardDrawSeq > lastCardSeq && lastCardSeq >= 0 && v.pendingCard && v.currentPlayerId === v.you) {
    showReveal(v.pendingCard)
  }
  lastCardSeq = v.cardDrawSeq

  render()
  maybeShowRoll(v)
  maybeShowGoPrompt(v)
  firstViewSeen = true
  // a roaming board stays live with the game
  phoneBoard?.sync(v)
})

// ── Actions ──

function send(a: Action): void {
  socket.emit('game:action', a, (res: { ok: boolean; error?: string }) => {
    if (!res.ok) toast(res.error ?? 'Not allowed right now')
  })
}

$app.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest('[data-act]') as HTMLElement | null
  if (!el) return
  const act = el.dataset.act
  const args = JSON.parse(el.dataset.args ?? '{}') as Record<string, unknown>

  switch (act) {
    case 'theme':
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
      socket.emit('room:join', { code: joinCode, name: joinName, piece: joinPiece }, (res: JoinAck) => {
        if (!res.ok) {
          // a taken piece gets crossed out in the grid, not just a toast
          const m = /(\S+) is already taken/.exec(res.error ?? '')
          if (m) {
            joinTaken.add(m[1])
            renderJoin()
            toast(`${m[1]} is taken — pick another piece`)
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
      avatarPreview?.show(TOKENS.indexOf(joinPiece), PREVIEW_COLOR)
      break
    }
    case 'lobbyPiece': {
      // change your piece in the lobby — optimistic selection, server
      // confirms with a lobby broadcast (or rejects a taken piece)
      const piece = el.dataset.piece ?? ''
      const wearing = lobby?.players.find((p) => p.id === myPlayerId)?.token
      if (!piece || piece === wearing) return
      lobbySel = piece
      document.querySelectorAll('.tok').forEach((b) => {
        b.classList.toggle('sel', (b as HTMLElement).dataset.piece === piece)
      })
      avatarPreview?.show(TOKENS.indexOf(piece), PREVIEW_COLOR)
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
    case 'kickPlayer': {
      const target = lobby?.players.find((p) => p.id === String(args.id))
      if (!lobby || !target) return
      showActionConfirm(
        'Kick this player?',
        `Remove <b>${target.token} ${esc(target.name)}</b> from the room — they can rejoin with the room code until the game starts.`,
        'Kick',
        () => {
          socket.emit('room:kick', { playerId: target.id }, (res: { ok: boolean; error?: string }) => {
            if (!res.ok) toast(res.error ?? 'Could not kick')
          })
        },
      )
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
      // Both exits (lobby "Leave room" and the in-game "Exit") start the
      // same two-step confirmation — see showExitConfirm.
      showExitConfirm(1)
      break
    }
    case 'showBoard': {
      showBoard()
      break
    }
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
})

$app.addEventListener('input', (ev) => {
  const el = ev.target as HTMLInputElement
  if (!el.dataset.k || !composer) return
  const v = view
  if (!v) return
  const n = Math.max(0, Math.floor(Number(el.value) || 0))
  if (el.dataset.k === 'giveCash') composer.giveCash = Math.min(n, meOf(v).cash)
  if (el.dataset.k === 'recvCash') composer.recvCash = Math.min(n, partnerPlayer(v, composer.partner)?.cash ?? 0)
})

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
  // piece stage: each emoji is tied to its own 3D avatar, previewed live
  $app.innerHTML = `
    <div class="join">
      <h1>MONOPOLY PARTY</h1>
      <div class="card">
        <div class="join-summary">Room <b>${esc(joinCode)}</b> · playing as <b>${esc(joinName)}</b> <button class="tiny" data-act="joinBack">Change</button></div>
        <label>Choose your piece</label>
        <div class="tokgrid">
          ${TOKENS.map(
            (t) =>
              `<button type="button" class="tok${t === joinPiece ? ' sel' : ''}${joinTaken.has(t) ? ' taken' : ''}" data-piece="${t}" data-act="pickPiece"${joinTaken.has(t) ? ' disabled' : ''}>${t}</button>`,
          ).join('')}
        </div>
        <div id="avatarStage"></div>
        <button class="big primary" data-act="join">Join as ${esc(joinName)}</button>
        <p class="hint">Every piece has its own 3D avatar — that's what walks the board.</p>
      </div>
    </div>`
  const stage = document.getElementById('avatarStage')
  if (stage) {
    avatarPreview = new AvatarPreview(stage)
    avatarPreview.show(TOKENS.indexOf(joinPiece), PREVIEW_COLOR)
  }
}

function renderLobby(l: LobbyInfo): void {
  disposeAvatarPreview()
  const isHost = myPlayerId != null && myPlayerId === l.hostId
  const me = l.players.find((p) => p.id === myPlayerId)
  const players = l.players
    .map((p) => {
      const kick = isHost && p.id !== myPlayerId ? `<button class="tiny kickbtn" data-act="kickPlayer" data-args='{"id":"${p.id}"}' title="Kick from the room">✕</button>` : ''
      return `<li${p.id === l.hostId ? ' class="crowned"' : ''}><span class="dot" style="background:${p.color}"></span>${p.token} ${esc(p.name)}${p.id === l.hostId ? ' <span class="crown">Host</span>' : ''}${p.connected ? '' : '<em class="off"> (offline)</em>'}${kick}</li>`
    })
    .join('')
  const others = l.players.filter((p) => p.id !== myPlayerId)
  const myPiece = lobbySel ?? me?.token ?? TOKENS[0]
  // your piece is yours to change until the game starts
  const pieceEditor = me ? `
      <label>Your piece — tap to change</label>
      <div class="tokgrid">
        ${TOKENS.map(
          (t) =>
            `<button type="button" class="tok${t === myPiece ? ' sel' : ''}${l.players.some((p) => p.id !== myPlayerId && p.token === t) ? ' taken' : ''}" data-piece="${t}" data-act="lobbyPiece"${t === myPiece || l.players.some((p) => p.id !== myPlayerId && p.token === t) ? ' disabled' : ''}>${t}</button>`,
        ).join('')}
      </div>
      <div id="avatarStage"></div>` : ''
  $app.innerHTML = `
    <div class="card">
      <h2>Room ${esc(l.code)}</h2>
      <p class="good">You're in${isHost ? ' — and you\u2019re the party host' : ''}.</p>
      <h3>Players (${l.players.length})</h3>
      <ul class="playerlist">${players}</ul>
      ${pieceEditor}
      ${isHost ? `
        <button class="big primary" data-act="startGame" ${l.canStart ? '' : 'disabled'}>Start the game</button>
        ${!l.canStart ? '<p class="hint">Best with 3+ players — waiting…</p>' : ''}
        ${others.length > 0 ? `
          <label>Hand over host duties</label>
          <div class="chips">${others.map((p) => `<button class="chip" data-act="handOver" data-args='{"to":"${p.id}"}'>Host: ${esc(p.name)}</button>`).join('')}</div>` : ''}
      ` : '<p class="hint">Waiting for the host to start the game…<br/>Keep this tab open.</p>'}
      <div class="row"><button class="tiny" data-act="leave">Leave room</button></div>
    </div>`
  // live 3D preview of the piece you're wearing (or about to take)
  const stage = document.getElementById('avatarStage')
  if (stage && me) {
    avatarPreview = new AvatarPreview(stage)
    avatarPreview.show(TOKENS.indexOf(myPiece), PREVIEW_COLOR)
  }
}

function renderGame(v: PlayerView): void {
  const I = meOf(v)
  if (!I.id) {
    $app.innerHTML = `<div class="card"><h2>Spectating</h2><p class="hint">This room's game is already running.</p></div>`
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
    const who = I.id === v.currentPlayerId ? 'You' : `${drawer?.token ?? ''} ${esc(drawer?.name ?? '')}`
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
          : `<span class="ls-rent">${owner.token} ${esc(owner.name)} — earns <b>$${rp.current}</b>${sp.kind === 'utility' ? ` (${rp.note})` : ''}</span>`
      } else if (owner) {
        // someone else's property — if it's MINE, the rent is mine to collect
        const who = owner.id === I.id ? '<b>yours to collect</b>' : `${owner.token} ${esc(owner.name)}`
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
    const rentForSpace = v.debt.memo?.startsWith('Rent: ') ? v.debt.memo.slice(6) : null
    banner = `<div class="banner debt">You owe <b>$${v.debt.amount}</b> to ${creditor ? `${creditor.token} ${esc(creditor.name)}` : 'the bank'}${rentForSpace ? ` — rent for <b>${esc(rentForSpace)}</b>` : ''}</div>`
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
    banner = `<div class="banner info">${esc(debtor?.name ?? '')} is raising funds to pay a debt…</div>`
  } else if (v.phase === 'AUCTION' && v.auction) {
    const sp = BOARD[v.auction.space]
    const bidder = v.players.find((p) => p.id === v.auction?.bidder)
    const mine = v.auction.bidder === I.id
    banner = `<div class="banner auction">Auction: <b>${esc(sp.name)}</b> — $${v.auction.bid}${bidder ? ` (${esc(bidder.name)})` : ''}</div>`
    if (mine) {
      body += `<div class="card"><h3>You're the high bidder</h3><p class="hint">Waiting for the others…</p></div>`
    } else if (acts.has('bid') || acts.has('passBid')) {
      const min = v.auction.bid + 1
      body += `
        <div class="card">
          <h3>Bid or pass</h3>
          <div class="row">
            <button data-act="bid" data-args='{"amount":${min}}'>$${min}</button>
            <button data-act="bid" data-args='{"amount":${v.auction.bid + 10}}'>+$10</button>
            <button data-act="bid" data-args='{"amount":${v.auction.bid + 50}}'>+$50</button>
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
    banner = `<div class="banner info">${arrested?.token ?? ''} ${esc(arrested?.name ?? '')} is under arrest — waiting for them to go to jail…</div>`
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
    banner = `<div class="banner info">${cur ? `${cur.token} <b>${esc(cur.name)}</b>'s turn` : 'Waiting…'}</div>`
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

  // ── Transaction history (yours and everyone else's) ──
  body += renderLedger(v, I.id)

  $app.innerHTML = `
    <header class="topbar" style="--c:${I.color}">
      <span class="me">${I.token} ${esc(I.name)}</span>
      <span class="money" id="moneyChip">$${I.cash}</span>
      <span class="meta">worth $${worth}${I.jailCards > 0 ? ` · jail card ×${I.jailCards}` : ''}${I.jail ? ' · in jail' : ''}</span>
      <button class="themebtn" data-act="theme">${theme === 'light' ? 'Dark' : 'Light'}</button>
      <button class="themebtn" data-act="showBoard">Board</button>
      <button class="themebtn exitbtn" data-act="leave">Exit</button>
    </header>
    ${banner}
    ${landedStrip}
    ${drawStrip}
    ${deadlineChip}
    <main>${body}</main>
    ${composer && composer.open ? renderComposer(v) : ''}`

  // the wallet counts to its new balance, with a floating delta
  if (prevCash != null && prevCash !== I.cash) animateMoney(prevCash, I.cash)
}

function sideSummary(side: TradeSide): string {
  const parts: string[] = []
  if (side.cash > 0) parts.push(`$${side.cash}`)
  for (const i of side.spaces) parts.push(esc(BOARD[i].name))
  if (side.jailCards > 0) parts.push(`jail card ×${side.jailCards}`)
  return parts.join(' + ') || 'nothing'
}

function tradeCard(v: PlayerView, t: TradeOffer, dir: 'incoming' | 'outgoing'): string {
  const from = v.players.find((p) => p.id === t.from)
  const to = v.players.find((p) => p.id === t.to)
  return `<div class="card trade">
    <div><b>${from?.token} ${esc(from?.name ?? '')}</b> offers <b>${sideSummary(t.give)}</b><br/>in exchange for <b>${sideSummary(t.receive)}</b> <span class="hint">(${esc(to?.name ?? '')})</span></div>
    ${dir === 'incoming'
      ? `<div class="row"><button class="good" data-act="acceptTrade" data-args='{"id":"${t.id}"}'>Accept</button><button class="danger" data-act="declineTrade" data-args='{"id":"${t.id}"}'>Decline</button></div>`
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
      const btns: string[] = []
      if (canBuildOn(v, pid, i)) btns.push(`<button class="tiny" data-act="buyHouse" data-args='{"space":${i}}'>House +$${isStreet(sp) ? sp.houseCost : ''}</button>`)
      if (canSellHouseOn(v, pid, i)) btns.push(`<button class="tiny" data-act="sellHouse" data-args='{"space":${i}}'>Sell house +$${isStreet(sp) ? sp.houseCost / 2 : ''}</button>`)
      if (canMortgageOn(v, pid, i)) btns.push(`<button class="tiny" data-act="mortgage" data-args='{"space":${i}}'>Mortgage +$${('price' in sp ? sp.price : 0) / 2}</button>`)
      if (canUnmortgageOn(v, pid, i)) btns.push(`<button class="tiny" data-act="unmortgage" data-args='{"space":${i}}'>Unmortgage −$${unmortgageCost('price' in sp ? sp.price : 0)}</button>`)
      const relevantPhase = v.phase === 'DEBT' ? ['mortgage', 'sellHouse'] : null
      const show = btns.length > 0 && (!relevantPhase || btns.some((b) => relevantPhase.some((rt) => b.includes(`data-act="${rt}"`))))
      return `<div class="prop">
        ${strip}
        <div class="pinfo">
          <div class="pname">${esc(sp.name)}${marks ? ` <span class="hint">${marks}</span>` : ''}</div>
          ${earn ? `<div class="pearn">${earn}</div>` : ''}
          ${show ? `<div class="row">${btns.join('')}</div>` : ''}
        </div>
      </div>`
    })
    .join('')
  return `<div class="trades"><h3>YOUR PROPERTIES (${owned.length})</h3>${rows}</div>`
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
        `<button class="chip ${p.id === sel ? 'sel' : ''}" style="${p.id === sel ? `border-color:${p.color}` : ''}" data-act="ledgerTab" data-args='{"id":"${p.id}"}' ${p.bankrupt ? 'disabled' : ''}>${p.token} ${esc(p.name)}</button>`,
    ),
  ].join('')
  const rows = entries.length
    ? entries
        .map((e) => {
          const who = v.players.find((p) => p.id === e.playerId)
          const bal = e.balance != null ? `<span class="bal">$${e.balance}</span>` : ''
          return `<li><span class="who" style="color:${who?.color ?? 'inherit'}">${who?.token ?? ''}</span><span class="amt ${e.delta > 0 ? 'plus' : 'minus'}">${e.delta > 0 ? '+' : '−'}$${Math.abs(e.delta)}</span>${bal}<span class="memo">${esc(e.memo)}</span><span class="lturn">turn ${e.turn}</span></li>`
        })
        .join('')
    : '<li><span class="memo hint">No transactions yet.</span></li>'
  return `<div class="ledger">
    <h3>TRANSACTION HISTORY</h3>
    <div class="chips">${chips}</div>
    <ul class="ledger-list">${rows}</ul>
  </div>`
}

function renderComposer(v: PlayerView): string {
  const C = composer
  if (!C) return ''
  const I = meOf(v)
  const partners = v.players.filter((p) => !p.bankrupt && p.id !== I.id)
  const partner = partnerPlayer(v, C.partner)
  const mySpaces = Object.entries(v.props).filter(([, st]) => st.owner === I.id)
  const theirSpaces = Object.entries(v.props).filter(([, st]) => st.owner === C.partner)
  const chip = (i: number, selected: boolean, which: 'give' | 'recv'): string => {
    const sp = BOARD[i]
    const col = isStreet(sp) ? GROUP_COLORS[sp.group] : '#9aa1ad'
    return `<button class="chip ${selected ? 'sel' : ''}" style="border-color:${col}" data-act="${which === 'give' ? 'toggleGiveSpace' : 'toggleRecvSpace'}" data-args='{"space":${i}}'>${esc(sp.name)}</button>`
  }
  return `
    <div class="modal" data-act="closeTrade">
      <div class="sheet" data-act="">
        <h3>Propose a trade</h3>
        <label>Trade with</label>
        <div class="row">
          ${partners.map((p) => `<button class="chip ${C.partner === p.id ? 'sel' : ''}" data-act="composerPartner" data-args='{"partner":"${p.id}"}'>${p.token} ${esc(p.name)}</button>`).join('')}
        </div>
        <label>You give</label>
        <div class="chips">${mySpaces.map(([iStr]) => chip(Number(iStr), C.giveSpaces.includes(Number(iStr)), 'give')).join('')}</div>
        <div class="row">
          <input data-k="giveCash" type="number" inputmode="numeric" min="0" value="${C.giveCash}" placeholder="cash up to $${I.cash}" />
          ${I.jailCards > 0 ? `<button class="chip ${C.giveJail > 0 ? 'sel' : ''}" data-act="composerJail" data-args='{"side":"give"}'>Jail card</button>` : ''}
        </div>
        <label>${partner ? `${partner.token} ${esc(partner.name)} gives` : 'They give'}</label>
        <div class="chips">${theirSpaces.map(([iStr]) => chip(Number(iStr), C.recvSpaces.includes(Number(iStr)), 'recv')).join('') || '<span class="hint">they own nothing</span>'}</div>
        <div class="row">
          <input data-k="recvCash" type="number" inputmode="numeric" min="0" value="${C.recvCash}" placeholder="cash up to $${partner?.cash ?? 0}" />
          ${(partner?.jailCards ?? 0) > 0 ? `<button class="chip ${C.recvJail > 0 ? 'sel' : ''}" data-act="composerJail" data-args='{"side":"recv"}'>Jail card</button>` : ''}
        </div>
        <div class="row">
          <button class="big primary" data-act="sendTrade">Send offer</button>
          <button class="big" data-act="closeTrade">Cancel</button>
        </div>
      </div>
    </div>`
}

// First paint: never leave the phone blank while the socket warms up.
render()
