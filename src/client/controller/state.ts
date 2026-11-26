// ── Phone state ──
// Every piece of module-level mutable state the split modules share, each
// behind its accessor: the screen pair (view/lobby), identity, the join
// flow, the trade-composer draft, the open sheet kind, the roll state
// machine (moved here as a unit with its reset), the frozen card-effect
// line, and the pocket-board handle. Mutations go through these
// functions only — no other module owns a copy.

import type { Board3D } from '../host/board3d.js'
import { AvatarPreview } from '../tokens3d.js'
import { cardEffectLine } from '../../shared/card-effect.js'
import { TOKENS } from '../../shared/tokens.js'
import { COLORS } from '../../shared/colors.js'
import type { LobbyInfo, PlayerView } from '../../shared/types.js'

// ── theme ──
export type Theme = 'light' | 'dark'
let theme: Theme = (localStorage.getItem('mp-theme') as Theme | null) ?? 'light'
document.documentElement.dataset.theme = theme
export function getTheme(): Theme {
  return theme
}
export function setTheme(next: Theme): void {
  theme = next
  localStorage.setItem('mp-theme', theme)
  document.documentElement.dataset.theme = theme
}

// ── the attention ding's on/off (persisted per browser) ──
let dingOn = (localStorage.getItem('mp-ding') ?? '1') !== '0'
export function getDingOn(): boolean {
  return dingOn
}
export function toggleDingOn(): void {
  dingOn = !dingOn
  localStorage.setItem('mp-ding', dingOn ? '1' : '0')
}

// ── the screen pair ──
let view: PlayerView | null = null
let lobby: LobbyInfo | null = null
export function getView(): PlayerView | null {
  return view
}
export function setView(v: PlayerView | null): void {
  view = v
}
export function getLobby(): LobbyInfo | null {
  return lobby
}
export function setLobby(l: LobbyInfo | null): void {
  lobby = l
}

// ── identity (persisted per browser) ──
let myName = ''
let myToken: string | null = localStorage.getItem('mp-token')
let myPlayerId: string | null = localStorage.getItem('mp-playerid')
export function getMyName(): string {
  return myName
}
export function setMyName(name: string): void {
  myName = name
}
export function getMyToken(): string | null {
  return myToken
}
export function setMyToken(token: string | null): void {
  myToken = token
}
export function getMyPlayerId(): string | null {
  return myPlayerId
}
export function setMyPlayerId(id: string | null): void {
  myPlayerId = id
}

// True while a stored rejoin token is being checked — show a connecting card
// instead of flashing the join form at a returning player.
let rejoinPending = myToken != null
export function getRejoinPending(): boolean {
  return rejoinPending
}
export function setRejoinPending(v: boolean): void {
  rejoinPending = v
}

// Trade composer state survives re-renders AND sheet closes: a view push
// patches the open sheet in place (inputs untouched), and closing it only
// hides the draft — reopening shows it exactly as it was left.
export interface Composer {
  partner: string
  giveCash: number
  giveSpaces: number[]
  giveJail: number
  recvCash: number
  recvSpaces: number[]
  recvJail: number
}
let composer: Composer | null = null
export function getComposer(): Composer | null {
  return composer
}
export function setComposer(c: Composer | null): void {
  composer = c
}

// ── the sheet system's open-kind state ──
// ONE sheet at a time (the pocket board is deliberately NOT a sheet —
// it is the full-screen WebGL overlay with its own toolbar). Every close
// funnels through closeSheet() (sheets.ts): the ✕, the backdrop, Escape,
// Android back and the Leave teardown are one code path, so none can
// double-fire.
export type SheetKind = 'deeds' | 'more' | 'composer'
let sheet: SheetKind | null = null
export function getSheet(): SheetKind | null {
  return sheet
}
export function setSheet(kind: SheetKind | null): void {
  sheet = kind
}

// true while our own history.back() is consuming the pushed cover entry —
// the popstate handler recognises its own pop and stands down (shared by
// the sheet close and the board close).
let popGuard = false
export function getPopGuard(): boolean {
  return popGuard
}
export function setPopGuard(v: boolean): void {
  popGuard = v
}

// Deed grid filters: owner is 'ALL' | 'UNOWNED' | a playerId; kind is 'ALL' |
// a color-group key | 'rail' | 'utility'. Both single-select, AND-combined.
export interface DeedFilters {
  owner: string
  kind: string
}
let deedFilters: DeedFilters = { owner: 'ALL', kind: 'ALL' }
export function getDeedFilters(): DeedFilters {
  return deedFilters
}
export function setDeedFilters(f: DeedFilters): void {
  deedFilters = f
}

// animation bookkeeping for the card reveal
let lastCardSeq = -1
export function getLastCardSeq(): number {
  return lastCardSeq
}
export function setLastCardSeq(n: number): void {
  lastCardSeq = n
}

// ledger tab (defaults to "me")
let ledgerTab: string | null = null
export function getLedgerTab(): string | null {
  return ledgerTab
}
export function setLedgerTab(id: string | null): void {
  ledgerTab = id
}

// ── the join flow ──
// Join flow, two steps: name first, then the piece. The piece step shows a
// live 3D preview of the avatar the emoji is tied to — what you pick here
// is exactly what walks the TV board.
let joinStage: 'name' | 'piece' = 'name'
let joinCode = ''
let joinName = ''
// the piece picked on the join screen (defaults to the first in the list)
let joinPiece = TOKENS[0]
// pieces the server refused as taken (mutated in place)
export const joinTaken = new Set<string>()
// the colour picked on the join screen (defaults to the first in the list)
let joinColor = COLORS[0]
// optimistic selections in the lobby (cleared once the broadcast lands)
let lobbySel: string | null = null
let lobbyColorSel: string | null = null
let avatarPreview: AvatarPreview | null = null

export function getJoinStage(): 'name' | 'piece' {
  return joinStage
}
export function setJoinStage(stage: 'name' | 'piece'): void {
  joinStage = stage
}
export function getJoinCode(): string {
  return joinCode
}
export function setJoinCode(code: string): void {
  joinCode = code
}
export function getJoinName(): string {
  return joinName
}
export function setJoinName(name: string): void {
  joinName = name
}
export function getJoinPiece(): string {
  return joinPiece
}
export function setJoinPiece(piece: string): void {
  joinPiece = piece
}
export function getJoinColor(): string {
  return joinColor
}
export function setJoinColor(color: string): void {
  joinColor = color
}
export function getLobbySel(): string | null {
  return lobbySel
}
export function setLobbySel(sel: string | null): void {
  lobbySel = sel
}
export function getLobbyColorSel(): string | null {
  return lobbyColorSel
}
export function setLobbyColorSel(sel: string | null): void {
  lobbyColorSel = sel
}

export function getAvatarPreview(): AvatarPreview | null {
  return avatarPreview
}
export function setAvatarPreview(p: AvatarPreview | null): void {
  avatarPreview = p
}
export function disposeAvatarPreview(): void {
  avatarPreview?.dispose()
  avatarPreview = null
}

// ── the frozen card-effect line ──
// Dynamic effect copy (repairs totals, pay-each counts) is computed ONCE
// per cardDrawSeq, at draw time, and reused for the whole reveal: a
// repairs bill can never shrink mid-reveal while a 90s raise-funds
// window and autoSettle mutate the estate. Static lines are immune by
// construction; recomputing on a seq bump covers a mid-reveal join too.
let frozenCardSeq = -1
let frozenEffectLine = ''

export function getFrozenEffectLine(): string {
  return frozenEffectLine
}
export function resetFrozenEffect(): void {
  frozenCardSeq = -1
  frozenEffectLine = ''
}

export function freezeEffectLine(v: PlayerView): void {
  if (v.cardDrawSeq === frozenCardSeq && v.pendingCard) return
  frozenCardSeq = v.cardDrawSeq
  frozenEffectLine =
    v.pendingCard && v.cardDrawSeq > 0 ? cardEffectLine(v.pendingCard, v, v.currentPlayerId) ?? '' : ''
}

// ── the roll state machine ──
// (council ruling, replaces the old lastRollKey dedupe): dice are a NEW
// roll only when they first appear (the previous view had none) or when
// the previous view sat in the ROLL phase (a doubles re-roll). Anything
// else that mutates the view's dice — the fresh utility roll behind a
// drawn card, a re-pushed view during a freeze — never replays the
// animation. The very first view of any kind is only a baseline:
// joining/reloading mid-turn must not replay a rolled roll.
let rollKey = ''
let rollPrevHadDice = false
let rollPrevPhase: PlayerView['phase'] | '' = ''
let rollSeen = false

// The bystander strip re-emits inside the main template for its lifetime,
// so a view push mid-strip rebuilds it instead of orphaning it.
export interface DiceStrip {
  html: string
  until: number
}
let diceStrip: DiceStrip | null = null
export function getDiceStrip(): DiceStrip | null {
  return diceStrip
}
export function setDiceStrip(d: DiceStrip | null): void {
  diceStrip = d
}

const rollKeyOf = (v: PlayerView): string =>
  v.dice ? `${v.turn}:${v.currentPlayerId}:${v.dice.join(',')}` : ''

// Consume a view push through the machine; true = a NEW roll just landed
// and the moment should play. maybeShowRoll (overlays.ts) does the showing.
export function maybeConsumeRoll(v: PlayerView): boolean {
  const key = rollKeyOf(v)
  let show = false
  if (!rollSeen) {
    rollSeen = true // first view of any kind = baseline; never animate it
  } else if (key && key !== rollKey && (!rollPrevHadDice || rollPrevPhase === 'ROLL')) {
    show = true // a NEW roll: first appearance of dice, or a re-roll from the ROLL phase
  }
  rollKey = key
  rollPrevHadDice = v.dice != null
  rollPrevPhase = v.phase
  return show
}

// The reset half of the machine, moved with it as one unit: seat gone
// (leave, kick, room closed) or a fresh rejoin starts from a cold
// baseline — the old seat's last roll must not replay.
export function resetRollMachine(): void {
  rollSeen = false
  rollKey = ''
  rollPrevHadDice = false
  rollPrevPhase = ''
}

// ── the pocket board handle ──
// The full 3D board overlay (overlays.ts owns its lifecycle); the handle
// lives here because two other modules only need to know whether it
// covers the screen (the your-move bar's visibility, the popstate
// arbitration).
let phoneBoard: Board3D | null = null
export function getPhoneBoard(): Board3D | null {
  return phoneBoard
}
export function setPhoneBoard(b: Board3D | null): void {
  phoneBoard = b
}
