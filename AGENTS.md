# AGENTS.md — how agents work in this repo

## The council rule (non-negotiable)

**Every new design choice must be reviewed by the council before it ships.**

A "design choice" is anything that isn't a mechanical fix: new features,
UX/flow changes, visual/layout decisions, gameplay/balance semantics,
copy that users read. Straightforward bug fixes with an obvious correct
answer may go straight to implementation.

The council is convened by delegating persona-scoped review tasks
(delegate_task / subagents), typically:

- **Game Designer** — rules, balance, game-state semantics
- **UX Designer** — flows, pacing, comprehension, copy
- **UI Designer** — layout, components, visual states
- **Game Director** — scope rulings, cross-domain adjudication,
  acceptance bar

Scaled to the change: a one-file bug gets one reviewer; a round of
features gets the full council plus a director ruling.

### The workflow, in order

1. **Dispatch the review BEFORE implementing** (analysis-only briefs;
   the reviewer reads the actual code and cites file:line). Reviews that
   touch disjoint domains may run in parallel.
2. **Implement per the council spec.** For multi-part rounds, delegate
   implementation to agents (sequential when they share files) and fix
   small review findings yourself.
3. **Verify**: every suite must be green before shipping — `npm run
   typecheck`, `scenarios`, `remedy`, `smoke`, `malformed`, `simulate`
   — plus whatever the review's verification plan requires (live
   probes against throwaway rooms on the droplet for server changes;
   manual visual checks described for the user where browser-only).
4. **A final council review** verifies the implemented work against the
   acceptance bar for anything larger than a trivial change; resolve
   SHOULD-FIX findings before shipping.
5. **Commit per concern** (one commit per feature/fix, message file
   `​.git-commit-msg.txt` — a stray em-dash will trip the Windows shell
   scanner, so always commit with `git commit -F .git-commit-msg.txt`),
   push to origin master, deploy to the droplet, and live-verify the
   served bundle hashes + a functional probe.
6. **Report deviations.** If the council's spec proved wrong mid-build,
   say so in the commit message or report — don't silently override.

### Established rulings (do not relitigate without new evidence)

- One estate rule: voluntary exit AND god kick route through
  `forfeitSeat` (player-creditor debts pay the lender; everything else
  bankrupts to the bank with deeds under the hammer).
- Disconnects are never punished: rejoinable seats, clock plays on.
- Phones render exactly what the server's `allowedActions` list says —
  no affordances the server refuses; freeze phases gray out with a
  reason.
- Auction proceeds go to the bank, never to a player.
- The TV corner controls are one fixed flex column (`.cornerctl`) —
  no hand-tuned per-button tops.
- Update prompts: never auto-reload; the pill is undismissable;
  inequality comparison (rollbacks count).
- Player identity in-game: the 3D avatar in the player's chosen colour
  replaces the emoji beside names (pickers keep gold model thumbnails;
  board pieces are the 3D models themselves).

## Repo facts

- Deploy target: droplet `root@139.59.80.55`, service
  `monopoly-party`, systemd unit, snapshots in
  `/var/lib/monopoly-party` (rooms survive restarts). Deploy =
  rsync-style tarball of `dist/` + `public/` (EXCLUDE `*.map`, INCLUDE
  subdirectories — `Copy-Item -Recurse`), then `systemctl restart`.
- The droplet has no `.git`: build IDs are minted on the dev machine by
  `scripts/build-clients.mjs` (baked into bundles via esbuild define +
  written to `dist/build-id.json`); rebuild AFTER committing so the
  shipped id matches the commit.
- The party gate (`PARTY_KEY`) protects everything, including
  `GET /version`. New routes must sit behind it.
- `npm run smoke` boots a server on :3123 (ungated);
  `npm run malformed` boots on :3124 gated. Both must stay green.
- Client bundles are served `no-store`; the update pill handles stale
  tabs.
- PowerShell quirks: avoid raw em-dashes/emoji in inline commit
  messages (use the message file); `Copy-Item` without `-Recurse`
   copies directories hollow; console ✗/✓ output mangles under
  several code pages — match on byte sequences when grepping test
  output.
