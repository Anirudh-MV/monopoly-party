# 🎲 Monopoly Party

A **Jackbox-style couch co-op Monopoly**: one TV (or laptop) shows the shared board for
everyone in the room, and every player uses their **phone** as a private controller —
wallet, deeds, buy/auction decisions, house-building, trades, even declaring bankruptcy
are all done from your own screen.

Phones join by scanning a **QR code** (or typing a short room code). Up to 8 players,
best with 3–6. LAN-first, deploy-ready.

```
   [TV / laptop]              [Node server]              [Phones]
   lobby + board + log   ←→   rooms + rules engine   ←→   your wallet & buttons
   (audience view)            (authoritative state)       (private controller)
```

## Quick start

Requires Node 18+.

```bash
npm install
npm run dev
```

1. Open **`http://localhost:3000`** on the TV/laptop → **Create a game**.
   You'll get a room code + QR code.
2. On each phone, scan the QR (or open the **LAN URL** shown on screen) →
   enter the room code + your name.
3. When everyone's in, hit **Start the game** on the TV.
4. Play. Roll, buy, trade, build, bankrupt your friends.

> **Windows firewall note:** the first time the server listens, Windows may pop a
> "Allow Node.js on private networks?" prompt — that's normal for LAN play, and it's
> the only prompt you'll ever see. If you miss it, allow Node manually in
> *Windows Defender Firewall → Allowed apps*.

> **Phones can't connect?** They must be on the **same Wi-Fi** as the host machine,
> and the host must use its LAN URL (printed at startup), not `localhost`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev mode: server with hot-reload + client rebuilds |
| `npm run simulate` | Headless fuzz-test: plays random games against the rules engine (see below) |
| `npm run smoke` | End-to-end test: boots the server, plays a real game over sockets, reconnects a phone + the TV |
| `npm run build` | Production build (server → `dist/`, clients → `public/*.js`) |
| `npm start` | Run the production build (`PORT` env to override, default 3000) |
| `npm run typecheck` | Strict TypeScript check across server + clients |

## How it works

- **`src/shared/`** — the whole domain: board data, the 32 chance/chest cards,
  the *rules helpers* (`rentFor`, `canBuildOn`, `allowedActions` …), and view types.
  Shared on purpose: **the server validates with the same functions the phone UI
  uses to decide which buttons to show.** No client/server drift about what's legal.
- **`src/server/engine.ts`** — the full official-rules engine as a deterministic
  state machine: `applyAction(state, action, playerId, rng)`. No I/O, no sockets.
- **`src/server/rooms.ts`** — socket glue: room codes, host/player tokens,
  per-device view projection, auto-pass for phones that drop mid-auction.
- **`src/server/index.ts`** — express + socket.io; binds `0.0.0.0` so LAN phones
  can reach it, prints its LAN URL at startup.
- **`src/client/host/`** — the TV app: lobby (code + QR), 11×11 board, tokens,
  ownership tinting, houses/hotels, auction + card + debt overlays, activity feed.
- **`src/client/controller/`** — the phone app: sticky wallet, contextual action
  buttons, per-property management, trade composer, auction bidding, debt resolution.

### Reconnects are a feature, not an afterthought

Phones lock, screens sleep, Wi-Fi blips. Each phone stores a rejoin token in
`localStorage`; on reconnect it re-attaches to its seat with wallet, deeds, and
jail cards intact. The TV has the same treatment via a host token. A phone that
drops mid-auction is **auto-passed** so the table never stalls.

### The engine is fuzz-tested

`npm run simulate` runs weighted-random bots through the reducer and asserts:
no exceptions, no deadlocks (every state always has at least one legal action),
no negative/NaN money, and every game terminates. It has already caught and fixed
real bugs: float rounding on mortgage interest, an auction that could wedge when
the last active player bid, and queued debts surviving a bankruptcy.

## Rules implemented (official, no house rules)

Full classic US-edition ruleset: buying & open ascending **auctions** (incl. bank
liquidation auctions), rent with color-set doubling, rail/util multipliers,
**even building** houses→hotels, mortgages at 110% buyback, income tax with the
flat-or-10% choice, luxury tax $75, GO $200, **doubles roll again** (three in a
row → jail), jail with all three exits (fine / card / doubles), chance & chest
decks (incl. "nearest railroad/utility" and repairs), **trading** properties/cash/
jail cards (buildings must be sold first), **debt resolution** (raise money by
selling/mortgaging before you can pay or go bankrupt), bankruptcy to a player
(estate transfers, 10% interest on mortgaged deeds) or to the bank (properties go
under the hammer). Last player standing wins.

Deviations you may care about (deliberate, for sanity in a party setting):

- Trades and building are allowed **between turns** — anyone, anytime it's
  not mid-auction or mid-debt. (Official rules also allow this; we just enforce
  it strictly at those two freeze points.)
- The "nearest utility" card charges 10× a fresh roll — we show the roll.

## Deploying (jackbox.tv-style)

Because nothing is baked in at build time, the same build runs anywhere:

```bash
npm run build
PORT=3000 npm start
```

Put it behind any reverse proxy with WebSocket support (Caddy/Nginx/Fly/Render),
share the public URL, and the QR/room-code flow works identically over the
internet. No config changes needed — the host screen shows whatever URL the
phones should use.

## Legal

This is a fan-made, open-source implementation for private play. *Monopoly* is a
trademark of Hasbro; this project is unaffiliated. It uses only rules/mechanics
(which aren't copyrightable) and its own artwork — no Hasbro assets.

## Roadmap ideas

- Timed decisions + a ticking sound (auction panic!)
- House-rules toggle sheet (landing on GO pays $400, free-parking pot, …)
- Emoji reactions beamed to the TV
- Spectator mode with a live "hot takes" feed
- Bot seats so 2 humans can still have a full table
