// ── Room manager barrel ──
// The split lives behind this file: the one module the suites and the
// server entry import ('./rooms.js') keeps its exact public surface —
// re-exported from the focused modules.
//   core.ts    — the Room type/registry, identity minting, host migration
//   clock.ts   — the one commit path, the broadcast surface, the decision
//                clock + auto-plays, the estate rule (forfeitSeat)
//   persist.ts — snapshots: save/load/validate/restore/quarantine
//   lobby.ts   — lobby lifecycle handler bodies (join/leave/reset/…)
//   god.ts     — the god console
//   sockets.ts — attach(): connection, rate limiting, event registration

export { commit, decisionFor, debtAutoActions, remedyActionsFor, auctionGraceActions, forfeitSeat } from './clock.js'
export { validateSnapshot, flushSnapshots, type RoomSnapshot } from './persist.js'
export { attach } from './sockets.js'
export { DEFAULT_ROUNDS_CAP, type Room } from './core.js'
