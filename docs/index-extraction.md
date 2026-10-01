# Extracting TuiApp — assessment and plan

`src/index.ts` after M2 is the cordis plugin shape plus one class, `TuiApp`
(~4,700 lines). This note records what the class body actually is, so the
extraction milestones sequence by evidence rather than by line count.

## Section coupling (measured on `main`, M2 complete)

| Section | Lines | `this.` refs | methods | Reading |
|---|---|---|---|---|
| behaviors | 912 | 256 | 19 | the app's action handlers; many seams, design first |
| key handling | 671 | 314 | 14 | densest state coupling; design first |
| fleet | 646 | 151 | 19 | low density, wide reach; design first |
| login | 550 | 134 | 17 | low density; design first |
| plugin panels | 321 | 92 | 13 | panel plumbing |
| clipboard | 172 | 43 | 7 | UI glue over `local-platform` |
| voice | 151 | 54 | 4 | UI glue over `voice.ts` |
| sessions | 83 | 32 | 6 | **owns `tabs`/`active` state + rules** |
| rendering | 101 | 64 | 6 | paint loop |
| plugins | 70 | 17 | 4 | plugin plumbing |
| persistence | 56 | 22 | 4 | save/restore glue over `persist.ts` |
| search | 50 | 14 | 3 | UI glue over `tui/state` match math |

Two facts drive the plan:

1. **The pure logic has already left.** `findMatches`, `layout`,
   `maxScrollBack`, `textMessage`, state assembly — the class methods are UI
   orchestrators (`setStatus`, `paint`, `screen.invalidate`), not hidden
   modules. Moving them as-is would create pass-throughs.
2. **State ownership is the seam.** `this.tabs` (44 refs) and `this.active`
   (23 refs) reach into 7 sections, but they are one coherent state cluster
   with real rules: bell on `ready`, seen-when-active, at-least-one-tab,
   theme-follows-tab. That cluster can be owned by a controller while
   `TuiApp` keeps thin accessors — **zero call-site changes**.

## The pattern: controller owns state and rules; the app keeps reactions

Each extraction moves a state cluster and its rules into a module; `TuiApp`
delegates through property accessors and keeps the UI reactions (paint,
status, picker) at its own edge. Rules the module owns: state transitions
and their invariants. Reactions the app keeps: drawing, status text,
persistence triggers.

## Sequenced slices

1. **`SessionTabs`** — owns `tabs`, `active`, the status/bell/seen rules,
   `summaries()`, `forAgent()`, removal with active-adjustment. `TuiApp`
   exposes `get/set tabs` and `get/set active` shims.
2. **`SearchState`** — owns `this.search` and the jump/cursor/wrap math; the
   app supplies the snapshot and applies `scrollBack` + status.
3. **The big four** (behaviors, key handling, fleet, login) — each needs its
   state inventory taken before any move: which fields a section reads,
   which it mutates, and which invariants hold across sections. Expect one
   controller per cluster (a `KeyMap`-style owner for key handling, a
   `FleetPanel` owner for fleet), not one giant split.

Non-goals: no behaviour change in any slice; every slice is gated on
typecheck, the full suite (local + sandbox), and a rebuilt `lib/` committed
with the source.

## The big four: state inventory (measured)

Reads dominated by the app's own reactions (`paint`, `setStatus`,
`persistSoon`, `screen.invalidate`) are reactions, not state — the owned
mutable state per cluster is what follows.

| Section | Top reads | Owned writes |
|---|---|---|
| fleet (646) | paint(32), setStatus(25) | `fleet`, `peers`, `presenceKey`, `usageLedger`+`usageEntries` (shared), 1 tab write |
| key handling (671) | setStatus(17), composer.value(14), runCommand(9), scroll(8) | `confirming`/`confirmAction`/`confirmPrompt`, `atDismissed`, `overlay`, 5 tab writes (via accessors) |
| behaviors (912) | setStatus(53), paint(39), persistSoon(10) | `stagedImages`, `previewBaseLang`, turn lifecycle on the active tab |
| login (550) | setStatus(27), paint(26), panel(6) | `pendingLoginPrompt`, `loginAbort`, `loginPendingEntry`, `previewBaseTheme`/`previewBaseLang` |

### LoginFlow (from `login`)

- **Owns:** `pendingLoginPrompt`, `loginAbort`, `loginPendingEntry`, and the
  preview base theme/language a login pauses and restores.
- **Rules:** one login flow at a time; a new prompt supersedes the previous;
  abort on quit; the paused theme/language is restored exactly once.
- **Reactions (stay in TuiApp):** mounting the login panel, status, paint,
  picker, persistence.
- Shape: like `SearchState` — the controller returns what to mount or restore;
  the app draws it.

### UsageLedger, then FleetController (from `fleet`)

- **Blocker:** `usageLedger`/`usageEntries` are written here but read by
  persistence and the usage view — shared mutable state a fleet controller
  must not drag in.
- **Slice 1 — `UsageLedger`:** owns the ledger, the entries, and the fold rule
  built on `billedAtLastFold` (see the `SessionTab` field doc); consumers read.
- **Slice 2 — `FleetController`:** owns the fleet panel state, `peers`, and
  `presenceKey`; rules: presence-key derivation, refresh triggers; reactions:
  paint/status.

### KeyRouter (from `key handling`)

- **Owns:** the confirm state (`confirming`, `confirmAction`,
  `confirmPrompt`) and the key→intent binding table. Intent handlers stay on
  `TuiApp`.
- **Design decision at implementation:** whether the binding table is data (a
  key→intent map — inspectable, testable) with the app registering handlers,
  or the router owns semantics for a subset (scroll, search keys, palette) and
  delegates the rest. The 5 tab writes already go through the `SessionTabs`
  accessors; none move.

### TurnRunner (from `behaviors`)

- **Owns:** `stagedImages` and the turn lifecycle around a tab — send →
  stream → settle → queue drain (`drainQueue`).
- **Depends on:** `SessionTabs` (tab writes) and the queue rules. The
  stream/event plumbing is the largest surface here; design it after
  `LoginFlow` and `FleetController` have proven the callback pattern at
  bigger sizes.

### Sequencing

LoginFlow → UsageLedger → FleetController → KeyRouter → TurnRunner. Every
slice keeps the M2/M3 gates: typecheck, full suite local + sandbox, rebuilt
`lib/` committed with the source, and no behaviour change.
