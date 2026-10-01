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
