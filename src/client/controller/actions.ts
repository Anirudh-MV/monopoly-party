// ── Actions: the delegated interaction surface ──
// ONE handler serves BOTH roots: $app (the rebuilt main flow) and $chrome
// (the patch-managed sheets) are siblings, so a tap inside a sheet never
// bubbles through $app's listener — the same handler is registered on
// each root by main.ts. Every data-act in the phone routes through the
// switch below; the composer's input handler rides the same delegation.
// performExit and resetScreenStates (the seat-teardown paths shared with
// the socket handlers) live here too — they are the resolutions of the
// leave/kick/closed interactions.

import { BOARD } from '../../shared/board.js'
import { TOKENS, stripEmoji } from '../../shared/tokens.js'
import { COLORS } from '../../shared/colors.js'
import { unmortgageCost } from '../../shared/rules.js'
import type { Action, PlayerView, TradeSide } from '../../shared/types.js'
import {
  getAvatarPreview,
  getComposer,
  getDeedFilters,
  getDingOn,
  getJoinCode,
  getJoinColor,
  getJoinName,
  getJoinPiece,
  getLobby,
  getLobbyColorSel,
  getLobbySel,
  getMyPlayerId,
  getSheet,
  getTheme,
  getView,
  joinTaken,
  resetFrozenEffect,
  resetRollMachine,
  setComposer,
  setDeedFilters,
  setJoinColor,
  setJoinName,
  setJoinPiece,
  setJoinStage,
  setJoinCode,
  setLastCardSeq,
  setLedgerTab,
  setLobbyColorSel,
  setLobbySel,
  setMyName,
  setMyPlayerId,
  setMyToken,
  setLobby,
  setTheme,
  setView,
  toggleDingOn,
} from './state.js'
import { avathumb, esc, meOf, partnerPlayer, toast } from './shared.js'
import { ensureConnected, send, socket, type JoinAck } from './net.js'
import { render, renderJoin } from './screens.js'
import { closeSheet, openSheet, updateChrome } from './sheets.js'
import {
  closeBoard,
  isBoardOpen,
  showActionConfirm,
  showBoard,
  showExitConfirm,
  showPropInfo,
  showRenameEditor,
  showResetConfirm,
} from './overlays.js'

// Leaving is the one destructive thing a phone can do to itself: the
// two-step confirm (overlays.ts) lands here. The rejoin token dies with
// the ack, and every screen-local state goes back to cold.
function performExit(): void {
  document.querySelector('.confirm-overlay')?.remove()
  if (!ensureConnected()) return
  socket.emit('room:leave', {}, () => {
    localStorage.removeItem('mp-token')
    localStorage.removeItem('mp-playerid')
    setMyToken(null)
    setMyPlayerId(null)
    setLobby(null)
    setView(null)
    setComposer(null)
    setLastCardSeq(-1)
    resetScreenStates()
    render()
  })
}

// Seat gone (leave, kick, room closed): every screen-local state must go
// back to cold. A rejoin's first view is then a fresh baseline — the old
// roll machine must not replay the previous seat's last roll, and a dead
// sheet or board must not greet the join screen. closeSheet/closeBoard
// funnel the teardown (DOM, scroll lock, focus, the pushed history entry).
export function resetScreenStates(): void {
  if (isBoardOpen()) closeBoard()
  closeSheet()
  setDeedFilters({ owner: 'ALL', kind: 'ALL' })
  resetRollMachine()
  resetFrozenEffect()
}

// One delegated handler serves BOTH roots (see module header).
export function onActionClick(ev: MouseEvent): void {
  const el = (ev.target as HTMLElement).closest('[data-act]') as HTMLElement | null
  if (!el) return
  const act = el.dataset.act
  const args = JSON.parse(el.dataset.args ?? '{}') as Record<string, unknown>

  switch (act) {
    case 'theme': {
      setTheme(getTheme() === 'light' ? 'dark' : 'light')
      // imperative: the More sheet's label patches in place, nothing re-renders
      const label = document.querySelector('[data-mi="theme"]') as HTMLElement | null
      if (label) label.textContent = getTheme() === 'light' ? '🌙 Dark theme' : '☀️ Light theme'
      break
    }
    case 'dingToggle': {
      toggleDingOn()
      const label = document.querySelector('[data-mi="ding"]') as HTMLElement | null
      if (label) label.textContent = getDingOn() ? '🔔 Sound ding on' : '🔇 Sound ding off'
      break
    }
    case 'joinNext': {
      const code = (document.getElementById('code') as HTMLInputElement).value.trim().toUpperCase()
      const name = stripEmoji((document.getElementById('name') as HTMLInputElement).value)
      if (!/^[A-Z]{4}$/.test(code)) return toast('Enter the 4-letter room code')
      if (!name) return toast('Enter your name first')
      setJoinCode(code)
      setJoinName(name)
      setJoinStage('piece')
      renderJoin()
      break
    }
    case 'joinBack': {
      setJoinStage('name')
      renderJoin()
      break
    }
    case 'join': {
      if (!ensureConnected()) return
      socket.emit('room:join', { code: getJoinCode(), name: getJoinName(), piece: getJoinPiece(), color: getJoinColor() }, (res: JoinAck) => {
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
        setMyToken(res.token ?? null)
        setMyPlayerId(res.playerId ?? null)
        localStorage.setItem('mp-playerid', getMyPlayerId() ?? '')
        setMyName(getJoinName())
      })
      break
    }
    case 'pickPiece': {
      // toggle imperatively — a full re-render would restart the preview
      setJoinPiece(el.dataset.piece ?? getJoinPiece())
      document.querySelectorAll('.tok').forEach((b) => {
        b.classList.toggle('sel', (b as HTMLElement).dataset.piece === getJoinPiece())
      })
      getAvatarPreview()?.show(TOKENS.indexOf(getJoinPiece()), getJoinColor())
      break
    }
    case 'pickColor': {
      setJoinColor(el.dataset.color ?? getJoinColor())
      document.querySelectorAll('.swatch').forEach((b) => {
        b.classList.toggle('sel', (b as HTMLElement).dataset.color === getJoinColor())
      })
      getAvatarPreview()?.show(TOKENS.indexOf(getJoinPiece()), getJoinColor())
      break
    }
    case 'lobbyPiece': {
      // change your model in the lobby — optimistic selection, server
      // confirms with a lobby broadcast (or rejects a taken model)
      const piece = el.dataset.piece ?? ''
      const wearing = getLobby()?.players.find((p) => p.id === getMyPlayerId())?.token
      if (!piece || piece === wearing) return
      setLobbySel(piece)
      document.querySelectorAll('.tok').forEach((b) => {
        b.classList.toggle('sel', (b as HTMLElement).dataset.piece === piece)
      })
      getAvatarPreview()?.show(TOKENS.indexOf(piece), getLobbyColorSel() ?? getLobby()?.players.find((p) => p.id === getMyPlayerId())?.color ?? COLORS[0])
      socket.emit('room:setPiece', { piece }, (res: { ok: boolean; error?: string }) => {
        if (!res.ok) {
          toast(res.error ?? 'Could not change piece')
          setLobbySel(null)
          render() // back to what you're actually wearing
        } else {
          setJoinPiece(piece)
          setLobbySel(null)
        }
      })
      break
    }
    case 'lobbyColor': {
      // change your colour in the lobby — the avatar wears it on the board
      const color = el.dataset.color ?? ''
      const wearing = getLobby()?.players.find((p) => p.id === getMyPlayerId())?.color
      if (!color || color === wearing) return
      setLobbyColorSel(color)
      document.querySelectorAll('.swatch').forEach((b) => {
        b.classList.toggle('sel', (b as HTMLElement).dataset.color === color)
      })
      getAvatarPreview()?.show(TOKENS.indexOf(getLobbySel() ?? getLobby()?.players.find((p) => p.id === getMyPlayerId())?.token ?? TOKENS[0]), color)
      socket.emit('room:setColor', { color }, (res: { ok: boolean; error?: string }) => {
        if (!res.ok) {
          toast(res.error ?? 'Could not change colour')
          setLobbyColorSel(null)
          render()
        } else {
          setLobbyColorSel(null)
        }
      })
      break
    }
    case 'resetRoom': {
      showResetConfirm(1)
      break
    }
    case 'kickPlayer': {
      const target = getLobby()?.players.find((p) => p.id === String(args.id))
      if (!getLobby() || !target) return
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
      const me = getLobby()?.players.find((p) => p.id === getMyPlayerId())
      if (!getLobby() || !me) return
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
      if (getSheet()) closeSheet()
      showExitConfirm(1, performExit)
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
      if (getSheet() === 'more') closeSheet() // the dock toggles its sheet
      else openSheet('more')
      break
    }
    case 'closeMore': closeSheet(); break
    case 'openDeeds': {
      // plain open (dock) starts from default filters; table rows pass
      // their player as the owner filter
      if (getSheet() === 'deeds' && !args.owner) {
        closeSheet()
        break
      }
      setDeedFilters({ owner: args.owner ? String(args.owner) : 'ALL', kind: 'ALL' })
      openSheet('deeds')
      break
    }
    case 'closeDeeds': closeSheet(); break
    case 'deedOwner': {
      const owner = String(args.owner)
      const filters = getDeedFilters()
      setDeedFilters({ ...filters, owner: filters.owner === owner ? 'ALL' : owner })
      updateChrome(getView())
      break
    }
    case 'deedKind': {
      const kind = String(args.kind)
      const filters = getDeedFilters()
      setDeedFilters({ ...filters, kind: filters.kind === kind ? 'ALL' : kind })
      updateChrome(getView())
      break
    }
    case 'deedClearFilters':
      setDeedFilters({ owner: 'ALL', kind: 'ALL' })
      updateChrome(getView())
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
      const sp = getView() ? BOARD[space] : null
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
      const sp = getView() ? BOARD[space] : null
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
    case 'ledgerTab': setLedgerTab(String(args.id)); render(); break
    case 'openTrade': {
      const v = getView()
      if (!v) return
      // the dock toggles its sheet; a half-built draft reopens intact
      if (getSheet() === 'composer') {
        closeSheet()
        break
      }
      if (!getComposer()) {
        const partners = v.players.filter((p) => !p.bankrupt && p.id !== v.you)
        if (partners.length === 0) return toast('Nobody to trade with!')
        setComposer({
          partner: partners[0]?.id ?? '',
          giveCash: 0, giveSpaces: [], giveJail: 0,
          recvCash: 0, recvSpaces: [], recvJail: 0,
        })
      }
      openSheet('composer')
      break
    }
    case 'closeTrade': closeSheet(); break // hide, never lose — the draft stays
    case 'sendTrade': {
      const C = getComposer()
      if (!C) return
      const give: TradeSide = { cash: Math.max(0, Math.floor(C.giveCash)), spaces: C.giveSpaces, jailCards: C.giveJail }
      const receive: TradeSide = { cash: Math.max(0, Math.floor(C.recvCash)), spaces: C.recvSpaces, jailCards: C.recvJail }
      if (give.cash === 0 && give.spaces.length === 0 && give.jailCards === 0 && receive.cash === 0 && receive.spaces.length === 0 && receive.jailCards === 0) {
        return toast('Offer something!')
      }
      if (!ensureConnected()) return
      // the draft is only spent when the server accepts it — a refusal
      // (freeze, vanished partner) keeps the composer open, intact
      socket.emit('game:action', { type: 'proposeTrade', to: C.partner, give, receive }, (res: { ok: boolean; error?: string }) => {
        if (!res.ok) return toast(res.error ?? 'Not allowed right now')
        setComposer(null)
        if (getSheet() === 'composer') closeSheet()
      })
      break
    }
    case 'barJump': {
      // the your-move bar's tap: close whatever covers the action card,
      // then jump to it and pulse it (~600ms)
      if (isBoardOpen()) closeBoard() // re-renders the main flow underneath
      if (getSheet()) closeSheet()
      requestAnimationFrame(() => {
        const card = (document.querySelector('main .card.actions') ?? document.querySelector('main .card')) as HTMLElement | null
        if (!card) return
        card.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' })
        card.classList.add('pulse-card')
        setTimeout(() => card.classList.remove('pulse-card'), 650)
      })
      break
    }
    case 'composerPartner': if (getComposer()) { getComposer()!.partner = String(args.partner); render() } break
    case 'toggleGiveSpace': {
      const C = getComposer()
      if (!C) return
      const i = Number(args.space)
      C.giveSpaces = C.giveSpaces.includes(i) ? C.giveSpaces.filter((x) => x !== i) : [...C.giveSpaces, i]
      render()
      break
    }
    case 'toggleRecvSpace': {
      const C = getComposer()
      if (!C) return
      const i = Number(args.space)
      C.recvSpaces = C.recvSpaces.includes(i) ? C.recvSpaces.filter((x) => x !== i) : [...C.recvSpaces, i]
      render()
      break
    }
    case 'composerJail': {
      const v: PlayerView | null = getView()
      const C = getComposer()
      if (!C || !v) return
      if (args.side === 'give') C.giveJail = Math.max(0, Math.min(meOf(v).jailCards, C.giveJail === 0 ? 1 : 0))
      else C.recvJail = Math.max(0, Math.min(partnerPlayer(v, C.partner)?.jailCards ?? 0, C.recvJail === 0 ? 1 : 0))
      render()
      break
    }
  }
}

// The composer's cash inputs live in #chrome now; the same delegated
// input handler covers both roots. Writes only the composer STATE — the
// input element itself is never touched by a patch (focus/contents ride).
export function onComposerInput(ev: Event): void {
  const el = ev.target as HTMLInputElement
  const C = getComposer()
  if (!el.dataset.k || !C) return
  const v = getView()
  if (!v) return
  const n = Math.max(0, Math.floor(Number(el.value) || 0))
  if (el.dataset.k === 'giveCash') C.giveCash = Math.min(n, meOf(v).cash)
  if (el.dataset.k === 'recvCash') C.recvCash = Math.min(n, partnerPlayer(v, C.partner)?.cash ?? 0)
}
