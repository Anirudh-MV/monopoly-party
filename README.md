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

1. Open **`http://localhost:3000`** on the TV/laptop — a room starts on its
   own, no button to press. You'll get a room code + QR code — with a live 3D
   board spinning behind it. The code is kept in the tab's URL (`?room=CODE`),
   so reloading the TV returns to the same game.
2. On each phone, scan the QR (or open the **LAN URL** shown on screen) →
   enter the room code + your name → **pick your piece**, with a live 3D
   preview of the avatar that will walk the board. No two players can pick
   the same piece.
3. The **first player to join is the party host** 👑 (the TV can also start
   things). The host can hand duties to anyone; if the host leaves or drops,
   the crown slides down the queue automatically.
4. Play. Roll, buy, bid, trade, build, bankrupt your friends — the camera
   stays zoomed on the active piece and rides along with every hop.

> **Windows firewall note:** the first time the server listens, Windows may pop a
> "Allow Node.js on private networks?" prompt — that's normal for LAN play, and it's
> the only prompt you'll ever see. If you miss it, allow Node manually in
> *Windows Defender Firewall → Allowed apps*.

> **Phones can't connect?** They must be on the **same Wi-Fi** as the host machine,
> and the host must use its LAN URL (printed at startup), not `localhost`.

> **Bots instead of humans?** Open **`http://localhost:3000/simulate`** — 2–8 bots
> play the real engine in your browser at 10ms–5000ms per decision, with
> pause/resume and every setting in one menu.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev mode: server with hot-reload + client rebuilds |
| `npm run simulate` | CLI fuzz-test: random bot games against the rules engine |
| `npm run scenarios` | 28 deterministic rule scenarios (249 checks) |
| `npm run smoke` | End-to-end test: boots the server, plays a real game over sockets, reconnects a phone + the TV |
| `npm run malformed` | Network-layer hardening test: hostile payloads at every message type — the server must stay up and keep playing |
| `npm run build` | Production build (server → `dist/`, clients → `public/*.js`) |
| `npm start` | Run the production build (`PORT` env to override, default 3000) |
| `npm run typecheck` | Strict TypeScript check across server + clients |

## How it works

- **`src/shared/`** — the whole domain: board data, the 32 chance/chest cards,
  the *rules helpers* (`rentFor`, `canBuildOn`, `allowedActions` …), and view types.
  Shared on purpose: **the server validates with the same functions the phone UI
  uses to decide which buttons to show.** No client/server drift about what's legal.
- **`src/shared/engine.ts`** — the full official-rules engine as a deterministic
  state machine: `applyAction(state, action, playerId, rng)`. No I/O, no sockets.
- **`src/shared/validate.ts`** — the boundary: every client message is checked
  against a schema (whole numbers, fixed ranges, capped strings) before it
  reaches the engine. The engine stays I/O-free *because* this gate exists.
- **`src/server/rooms.ts`** — the import surface (a barrel) for the room
  layer; the split lives behind it: `core.ts` (registry + host migration),
  `clock.ts` (the one commit path + decision clock), `persist.ts`
  (snapshots), `lobby.ts` (join/leave/reset), `god.ts` (the TV console),
  `sockets.ts` (the wiring). Socket glue end to end: room codes,
  host/player tokens, per-device view projection, auto-pass for phones
  that drop mid-auction. Every handler runs inside a guard, so a
  malformed message can never crash the process — and one connection
  belongs to exactly one room.
- **`src/server/index.ts`** — express + socket.io; binds `0.0.0.0` so LAN phones
  can reach it, prints its LAN URL at startup.
- **`src/client/host/`** — the TV app: lobby (code + QR), 11×11 board, tokens,
  ownership tinting, houses/hotels, auction + card + debt overlays, activity feed.
- **`src/client/controller/`** — the phone app, split by concern:
  `net.ts` (the socket + reconnection), `state.ts` (the shared phone state
  + the roll state machine), `screens.ts` (the join/lobby/game render
  flow), `sheets.ts` (the chrome patcher: sheets, dock, your-move bar),
  `overlays.ts` (board, dice, confirms), `actions.ts` (the delegated
  command switch), with `main.ts` as the slim boot. Sticky wallet (with
  animated balance changes), contextual action buttons, per-property
  management, trade composer, auction bidding, debt resolution — rent is
  paid by hand, a Collect prompt marks passing GO, the dice roll plays on
  every screen, and a **pocket board** button opens the full 3D board to
  roam and inspect.
- **`src/client/tokens3d.ts`** — one distinct 3D avatar per emoji, shared by
  the TV board and the phone's piece picker (with a live preview).

### Reconnects are a feature, not an afterthought

Phones lock, screens sleep, Wi-Fi blips. Each phone stores a rejoin token in
`localStorage` and re-attaches automatically on **every** socket reconnect —
seat, wallet, deeds, and jail cards intact. The TV has the same treatment via
a host token. A phone that drops mid-auction is **auto-passed** (after a
grace period) so the table never stalls.

Leaving on purpose is harder than leaving by accident: **Exit** on a phone
asks for confirmation **twice** (different wording each step, and tapping the
backdrop counts as "stay"). Mid-game the seat stays at the table and the
rejoin token is destroyed — that phone can never rejoin the room, but it's
free to go enter a different room code right away.

### Decision clocks

Every decision point (roll, buy/auction, tax choice, end turn, debt) gets a
**300-second** server-authoritative deadline. Phones show the countdown only
in the **final 30 seconds** — and when it expires, the server plays a sensible
default (auto-roll, send to auction, end turn, pay or bankrupt) so a stalled
phone can never stall the party.

### The engine is fuzz- and scenario-tested

- `npm run simulate` — weighted-random bots play full games; asserts no
  exceptions, no deadlocks, no negative money, guaranteed termination.
- `npm run scenarios` — 28 deterministic situations (249 checks): GO payouts,
  rent tables, jail in every exit, chained card draws, even-building rules,
  exact mortgage math, multi-debt queues, both bankruptcy flavors, auction
  regressions, trade validation, tamper-proof action gating.
- `npm run smoke` — the full stack over real sockets, including reconnects.
- `npm run malformed` — hostile and half-broken payloads at every message
  type: wrong shapes, fractional cash, string numbers, 100k-char strings,
  prototype pollution, stale-socket crown theft. The server must survive it
  all and keep playing a normal game afterwards.

Together they've caught and fixed real bugs: float drift on mortgage buyback,
a wedged auction when the last active player bid, queued debts surviving a
bankruptcy, and a client-side first-paint blank screen.

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

Put it behind any reverse proxy with WebSocket support (Caddy/Nginx/Fly/Render)
and set `PUBLIC_URL` to the origin players reach, so the lobby QR code and join
link point there instead of the server's LAN address:

```bash
PUBLIC_URL=https://monopoly.example.com PORT=3000 npm start
```

A bare host is accepted (`PUBLIC_URL=monopoly.example.com` implies `https://`).
Without it, the host screen advertises the machine's LAN address, which is
correct for local play. `SNAP_DIR` relocates room snapshots (default
`snapshots/`); a crash or restart resumes in-progress games from them.

### Party gate — short-lived public instances (`PARTY_KEY`)

Game night on a public IP for one evening? Set a shared secret and every
route — pages, bundles, and the Socket.IO handshake — requires it:

```bash
PARTY_KEY=some-long-passphrase PUBLIC_URL=https://monopoly.example.com npm start
```

Three ways in:

- **Deep link**: open any URL with `?key=<PARTY_KEY>`. The server sets a
  session cookie, so it's typed exactly once per device. The lobby QR and
  join URL embed the key automatically — phones that scan the QR never see
  a prompt. (The key is on the TV screen anyway: it gates the internet, not
  the room — room codes still do that.)
- **HTTP Basic auth** (the 401 challenge is kept as a desktop/curl fallback):
  any username, the party key as the password.
- **Raw clients**: `Authorization: Bearer <key>`, or socket `auth: { key }`.

Smart-TV browsers are unreliable with 401 dialogs (and with the WebGL the TV
view needs) — drive the big screen from a laptop over HDMI or cast a tab, and
use the deep link on any device where typing credentials is awkward. Don't
also enable proxy-level basic auth; it duplicates this gate and breaks the
TV.

Failed attempts log `AUTHFAIL ip=<ip> path=<path>` to stdout, with the client
IP taken from `CF-Connecting-IP` / `X-Forwarded-For` behind a proxy — ready
for fail2ban on the droplet (journald backend, no log files):

```ini
# /etc/fail2ban/filter.d/monopoly-auth.conf
[Definition]
failregex = AUTHFAIL ip=<HOST> path=\S+

# /etc/fail2ban/jail.local
[monopoly-auth]
enabled  = true
backend  = systemd
journalmatch = _SYSTEMD_UNIT=monopoly-party.service
maxretry = 5
findtime = 10m
bantime  = 1h
```

This is a party gate, not bank-grade auth: the key is shared and appears in
URLs, browser history, and server logs. It exists so strangers can't crash
your evening — destroy the droplet when the party's over.

**Behind the Cloudflare proxy (orange cloud):** the droplet only ever sees
Cloudflare's source IPs, so local iptables bans are a no-op — ban at the edge
instead. Either use fail2ban's `cloudflare-apiv4` action (an API token adds
the real client to a Cloudflare block list; the `AUTHFAIL` lines already
carry the true IP via `CF-Connecting-IP`), or skip fail2ban and add a
Cloudflare rate-limiting rule on the hostname (same IP, >N req/min → block
1h). Also firewall the droplet's 80/443 to Cloudflare's published ranges
(https://www.cloudflare.com/ips/ — IPv4 **and** IPv6) so nobody can bypass
the edge and hit the origin directly, and set the zone's SSL mode to
**Full (strict)**, never Flexible.

## Legal

This is a fan-made, open-source implementation for private play. *Monopoly* is a
trademark of Hasbro; this project is unaffiliated. It uses only rules/mechanics
(which aren't copyrightable) and its own artwork — no Hasbro assets.

## Roadmap ideas

- House-rules toggle sheet (landing on GO pays $400, free-parking pot, …)
- Emoji reactions beamed to the TV
- Spectator mode with a live "hot takes" feed (beyond the TV mirrors that exist today)
- Bot seats at a real table (the `/simulate` page already runs full bot games)
