// ── Domain types shared by server engine, TV host, phone controllers, simulator ──

export type ColorGroup = 'brown' | 'lightblue' | 'pink' | 'orange' | 'red' | 'yellow' | 'green' | 'blue'

export type Space =
  | { kind: 'go' | 'jail' | 'parking' | 'gotojail' | 'chance' | 'chest'; name: string }
  | { kind: 'street'; name: string; price: number; group: ColorGroup; rents: [number, number, number, number, number, number]; houseCost: number }
  | { kind: 'rail'; name: string; price: number }
  | { kind: 'utility'; name: string; price: number }
  | { kind: 'tax'; name: string; flat: number; percent?: boolean }

// ── Cards ──

export type CardEffect =
  | { kind: 'goto'; target: number }
  | { kind: 'move'; steps: number }
  | { kind: 'nearest'; target: 'rail' | 'utility' }
  | { kind: 'money'; amount: number }
  | { kind: 'pay'; amount: number }
  | { kind: 'collectEach'; amount: number }
  | { kind: 'payEach'; amount: number }
  | { kind: 'jailcard' }
  | { kind: 'gotojail' }
  | { kind: 'repairs'; perHouse: number; perHotel: number }

export interface Card {
  id: string
  deck: 'chance' | 'chest'
  text: string
  effect: CardEffect
}

// ── Game state ──

export type Phase = 'LOBBY' | 'ROLL' | 'ACTION' | 'AUCTION' | 'DEBT' | 'GAME_OVER'

export interface PlayerState {
  id: string
  name: string
  color: string
  token: string
  cash: number
  pos: number
  jail: boolean
  jailRolls: number
  jailCards: number
  /** Why this player is in jail ("landed on Go To Jail" etc.), for displays. */
  jailReason: string | null
  bankrupt: boolean
  connected: boolean
}

export interface PropertyState {
  owner: string | null
  houses: number // 1..4 houses, 5 = hotel
  mortgaged: boolean
}

export interface AuctionState {
  space: number
  bid: number
  bidder: string | null
  passed: string[]
}

export interface DebtState {
  debtor: string
  amount: number
  creditor: string | null // null = bank
}

export interface TradeSide {
  cash: number
  spaces: number[]
  jailCards: number
}

export interface TradeOffer {
  id: string
  from: string
  to: string
  give: TradeSide // what `from` gives up
  receive: TradeSide // what `to` gives up
}

export interface LogEntry {
  text: string
  kind: 'info' | 'good' | 'bad' | 'money'
}

// A single money movement, for the per-player transaction history.
export interface MoneyEvent {
  seq: number
  turn: number
  playerId: string
  delta: number // + collected / − paid
  memo: string
  balance: number // the player's cash right after this movement
}

export interface GameState {
  phase: Phase
  players: PlayerState[]
  currentPlayerId: string
  dice: [number, number] | null
  doubles: number
  props: Record<number, PropertyState>
  chanceDeck: string[] // remaining card ids, front = next
  chestDeck: string[]
  pendingCard: Card | null
  // Two-step card draws: landing sets this, the player "opens the chest" /
  // "spins the wheel" from their phone, which then performs the actual draw.
  pendingCardDraw: { player: string; deck: 'chance' | 'chest'; space: number } | null
  cardDrawSeq: number // bumped on every reveal so screens can animate it
  // The announced-but-not-yet-executed jail sentence (two-step arrest).
  pendingJail: PendingJail | null
  pendingPurchase: number | null
  pendingTax: { player: string; space: number } | null
  pendingMove: number | null // steps to finish after a debt is resolved (jail fine case)
  auction: AuctionState | null
  auctionQueue: number[] // bankruptcy liquidations
  debt: DebtState | null
  debtQueue: DebtState[]
  trades: TradeOffer[]
  // The space the current player most recently landed on — the TV spotlights it.
  lastLanded: { playerId: string; space: number } | null
  // How the active piece last moved — the exact tile-by-tile path, so the TV
  // animates card advances ("nearest utility", "advance to GO") as a real
  // stroll instead of a teleport. null = snap (jail, god edits).
  lastMove: { playerId: string; path: number[] } | null
  // Full-information money ledger: every cash movement, visible to everyone.
  ledger: MoneyEvent[]
  // Wall-clock deadline (epoch ms) for the active decision, maintained by the
  // room layer. Hidden on phones until the final 30 seconds.
  deadline: number | null
  deadlineFor: string | null // playerId the countdown belongs to (null = everyone, e.g. auctions)
  log: LogEntry[]
  turn: number
  winner: string | null
}

// The subset of state the rules helpers need. GameState satisfies this structurally,
// and so do the client-facing views — so phones compute affordances with the exact
// same code the server validates with.
export interface RulesState {
  players: PlayerState[]
  props: Record<number, PropertyState>
  phase: Phase
  currentPlayerId: string
  dice: [number, number] | null
  pendingPurchase: number | null
  pendingTax: { player: string; space: number } | null
  pendingCardDraw: { player: string; deck: 'chance' | 'chest'; space: number } | null
  pendingJail: PendingJail | null
  debt: DebtState | null
  auction: AuctionState | null
  trades: TradeOffer[]
}

// ── Actions (phone → server) ──

export type Action =
  | { type: 'roll' }
  | { type: 'drawCard' }
  | { type: 'goToJail' }
  | { type: 'buy' }
  | { type: 'declineBuy' }
  | { type: 'bid'; amount: number }
  | { type: 'passBid' }
  | { type: 'endTurn' }
  | { type: 'buyHouse'; space: number }
  | { type: 'sellHouse'; space: number }
  | { type: 'mortgage'; space: number }
  | { type: 'unmortgage'; space: number }
  | { type: 'payTax'; choice: 'flat' | 'percent' }
  | { type: 'payJail' }
  | { type: 'useJailCard' }
  | { type: 'payDebt' }
  | { type: 'bankrupt' }
  | { type: 'proposeTrade'; to: string; give: TradeSide; receive: TradeSide }
  | { type: 'respondTrade'; tradeId: string; accept: boolean }
  | { type: 'cancelTrade'; tradeId: string }

export type ActionType = Action['type']

// ── Views (server → screens) ──

// Monopoly is a full-information game, so the host view is the whole public state.
// Phones additionally get their own allowed-actions list and the trades they're party to.
export interface HostView {
  code: string
  phase: Phase
  started: boolean
  turn: number
  currentPlayerId: string
  hostId: string | null
  players: PlayerState[]
  props: Record<number, PropertyState>
  dice: [number, number] | null
  log: LogEntry[]
  ledger: MoneyEvent[]
  auction: AuctionState | null
  pendingCard: Card | null
  pendingCardDraw: { player: string; deck: 'chance' | 'chest'; space: number } | null
  cardDrawSeq: number
  pendingJail: PendingJail | null
  pendingPurchase: number | null
  pendingTax: { player: string; space: number } | null
  debt: DebtState | null
  winner: string | null
  trades: TradeOffer[]
  lastLanded: { playerId: string; space: number } | null
  lastMove: { playerId: string; path: number[] } | null
  deadline: number | null
  deadlineFor: string | null
  turnTimeoutMs: number
}

export interface PlayerView extends HostView {
  you: string
  allowed: ActionType[]
  isHost: boolean
}

// ── The two-step arrest ──
// Landing on Go To Jail, drawing "Go directly to Jail", or rolling three
// doubles announces the sentence first; the arrested player taps "Go to
// Jail" on their phone (30s deadline) so the whole table sees it coming.

export type JailReason = 'space' | 'card' | 'doubles'

export const JAIL_REASONS: Record<JailReason, string> = {
  space: 'landed on Go To Jail',
  card: 'the card says: Go directly to Jail',
  doubles: 'rolled three doubles in a row',
}

export interface PendingJail {
  player: string
  reason: JailReason
}

// ── Lobby (pre-game) ──

export interface LobbyPlayer {
  id: string
  name: string
  color: string
  token: string
  connected: boolean
}

export interface LobbyInfo {
  code: string
  players: LobbyPlayer[]
  canStart: boolean
  hostId: string | null
  /** Decision deadline in ms; 0 = off. Set by the host in the lobby. */
  turnTimeoutMs: number
}

// ── God commands (TV host console only) ──
// Emergency operator controls: if the game hits a bug mid-party, the host
// can rescue the state instead of starting over. Every command is logged
// into the game log so the table sees what was done.

export type GodCommand =
  | { cmd: 'skipTurn' }
  | { cmd: 'replayTurn'; playerId?: string }
  | { cmd: 'setCash'; playerId: string; amount: number }
  | { cmd: 'setPos'; playerId: string; pos: number; jail?: boolean }
  | { cmd: 'setJail'; playerId: string; jail: boolean }
  | { cmd: 'setJailCards'; playerId: string; count: number }
  | { cmd: 'setProperty'; space: number; owner: string | null }
  | { cmd: 'setHouses'; space: number; count: number }
  | { cmd: 'setMortgaged'; space: number; mortgaged: boolean }
  | { cmd: 'forceDraw'; deck: 'chance' | 'chest' }
  | { cmd: 'setTimer'; ms: number }
  | { cmd: 'endGame'; winner?: string | null }
  | { cmd: 'export' }
  | { cmd: 'import'; json: unknown }
