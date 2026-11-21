// ── Phone controller ──
// Your wallet, your properties, your decisions — plus the full transaction
// ledger for every player. The server tells us what we're allowed to do
// (PlayerView.allowed) and the shared rules helpers give per-property
// affordances. Card spaces are interactive: open the chest / spin the wheel,
// and the reveal animates here and on the TV.

import { io } from 'socket.io-client'
import { BOARD, GROUP_COLORS, isStreet } from '../../shared/board.js'
import {
  canBuildOn,
  canMortgageOn,
  canSellHouseOn,
  canUnmortgageOn,
  netWorth,
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
let seenFirstView = false

// ledger tab (defaults to "me")
let ledgerTab: string | null = null

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

socket.on('view', (v: PlayerView) => {
  view = v
  lobby = null
  rejoinPending = false

  // fresh card draw? play the reveal once (never replay stale ones)
  if (lastCardSeq < 0) seenFirstView = true
  if (v.cardDrawSeq > lastCardSeq && lastCardSeq >= 0 && v.pendingCard) {
    showReveal(v.pendingCard)
  }
  lastCardSeq = v.cardDrawSeq

  render()
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
    case 'join': {
      const code = (document.getElementById('code') as HTMLInputElement).value.trim().toUpperCase()
      const name = (document.getElementById('name') as HTMLInputElement).value.trim()
      if (!code || !name) return toast('Room code and name, please!')
      socket.emit('room:join', { code, name }, (res: JoinAck) => {
        if (!res.ok) return toast(res.error ?? 'Could not join')
        localStorage.setItem('mp-token', res.token ?? '')
        myToken = res.token ?? null
        myPlayerId = res.playerId ?? null
        localStorage.setItem('mp-playerid', myPlayerId ?? '')
        myName = name
      })
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
      socket.emit('room:leave', {}, () => {
        localStorage.removeItem('mp-token')
        localStorage.removeItem('mp-playerid')
        myToken = null
        myPlayerId = null
        lobby = null
        view = null
        render()
      })
      break
    }
    case 'roll': send({ type: 'roll' }); break
    case 'drawCard': send({ type: 'drawCard' }); break
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
    case 'mortgage': send({ type: 'mortgage', space: Number(args.space) }); break
    case 'unmortgage': send({ type: 'unmortgage', space: Number(args.space) }); break
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
  return v?.players.find((p) => p.id === v.you) ?? { id: '', name: '', color: '', token: '', cash: 0, pos: 0, jail: false, jailRolls: 0, jailCards: 0, bankrupt: false, connected: false }
}
function partnerPlayer(v: PlayerView | null, pid: string) {
  return v?.players.find((p) => p.id === pid)
}

// ── Render ──

function render(): void {
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
  $app.innerHTML = `
    <div class="join">
      <h1>MONOPOLY PARTY</h1>
      <div class="card">
        <label>Room code</label>
        <input id="code" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="ABCD" value="${esc(preCode)}" />
        <label>Your name</label>
        <input id="name" maxlength="16" autocomplete="off" placeholder="e.g. Maya" />
        <button class="big primary" data-act="join">Join the game</button>
        <p class="hint">Get the code from the TV screen</p>
      </div>
    </div>`
}

function renderLobby(l: LobbyInfo): void {
  const isHost = myPlayerId != null && myPlayerId === l.hostId
  const players = l.players
    .map(
      (p) =>
        `<li${p.id === l.hostId ? ' class="crowned"' : ''}><span class="dot" style="background:${p.color}"></span>${p.token} ${esc(p.name)}${p.id === l.hostId ? ' <span class="crown">Host</span>' : ''}${p.connected ? '' : '<em class="off"> (offline)</em>'}</li>`,
    )
    .join('')
  const others = l.players.filter((p) => p.id !== myPlayerId)
  $app.innerHTML = `
    <div class="card">
      <h2>Room ${esc(l.code)}</h2>
      <p class="good">You're in${isHost ? ' — and you\u2019re the party host' : ''}.</p>
      <h3>Players (${l.players.length})</h3>
      <ul class="playerlist">${players}</ul>
      ${isHost ? `
        <button class="big primary" data-act="startGame" ${l.canStart ? '' : 'disabled'}>Start the game</button>
        ${!l.canStart ? '<p class="hint">Best with 3+ players — waiting…</p>' : ''}
        ${others.length > 0 ? `
          <label>Hand over host duties</label>
          <div class="chips">${others.map((p) => `<button class="chip" data-act="handOver" data-args='{"to":"${p.id}"}'>Host: ${esc(p.name)}</button>`).join('')}</div>` : ''}
      ` : '<p class="hint">Waiting for the host to start the game…<br/>Keep this tab open.</p>'}
      <div class="row"><button class="tiny" data-act="leave">Leave room</button></div>
    </div>`
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

  let banner = ''
  let body = ''

  // What the active player drew — an info strip, NEVER a blocker: the action
  // cascade below must always render so the game can always advance.
  let drawStrip = ''
  if (v.pendingCard && !v.pendingCardDraw) {
    drawStrip = `<div class="drawstrip">${I.id === v.currentPlayerId ? 'You drew' : `${cur ? esc(cur.name) : 'Someone'} drew`}: ${esc(v.pendingCard.text)}</div>`
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
    banner = `<div class="banner debt">You owe $${v.debt.amount} to ${creditor ? esc(creditor.name) : 'the bank'}</div>`
    body += `
      <div class="card urgent">
        <h3>Raise the money</h3>
        <p>Sell houses or mortgage properties below${acts.has('payDebt') ? ', then tap Pay.' : '.'}</p>
        ${acts.has('payDebt') ? `<button class="big good" data-act="payDebt">Pay $${v.debt.amount}</button>` : ''}
        <button class="big danger" data-act="bankrupt">Declare bankruptcy</button>
      </div>`
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
  } else if (v.phase === 'ROLL' && I.id === v.currentPlayerId) {
    banner = `<div class="banner good">Your turn${I.jail ? ' — you\u2019re in jail!' : ''}</div>`
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
        <h3>Unowned — $${price}</h3>
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

  // ── Transaction history (yours and everyone else's) ──
  body += renderLedger(v, I.id)

  // ── New trade button ──
  if (acts.has('proposeTrade')) {
    body += `<button class="big wide" data-act="openTrade">Propose a trade</button>`
  }

  $app.innerHTML = `
    <header class="topbar" style="--c:${I.color}">
      <span class="me">${I.token} ${esc(I.name)}</span>
      <span class="money">$${I.cash}</span>
      <span class="meta">worth $${worth}${I.jailCards > 0 ? ` · jail card ×${I.jailCards}` : ''}</span>
      <button class="themebtn" data-act="theme">${theme === 'light' ? 'Dark' : 'Light'}</button>
    </header>
    ${banner}
    ${drawStrip}
    ${deadlineChip}
    <main>${body}</main>
    ${composer && composer.open ? renderComposer(v) : ''}`
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
          ${show ? `<div class="row">${btns.join('')}</div>` : ''}
        </div>
      </div>`
    })
    .join('')
  return `<div class="trades"><h3>YOUR PROPERTIES (${owned.length})</h3>${rows}</div>`
}

// The full-information money ledger: pick any player, read their books.
function renderLedger(v: PlayerView, meId: string): string {
  const sel = ledgerTab ?? meId
  const entries = v.ledger.filter((e) => e.playerId === sel).slice(-25).reverse()
  const chips = v.players
    .map(
      (p) =>
        `<button class="chip ${p.id === sel ? 'sel' : ''}" style="${p.id === sel ? `border-color:${p.color}` : ''}" data-act="ledgerTab" data-args='{"id":"${p.id}"}' ${p.bankrupt ? 'disabled' : ''}>${p.token} ${esc(p.name)}</button>`,
    )
    .join('')
  const rows = entries.length
    ? entries
        .map(
          (e) =>
            `<li><span class="amt ${e.delta > 0 ? 'plus' : 'minus'}">${e.delta > 0 ? '+' : '−'}$${Math.abs(e.delta)}</span><span class="memo">${esc(e.memo)}</span><span class="lturn">turn ${e.turn}</span></li>`,
        )
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
