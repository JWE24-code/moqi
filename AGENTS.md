# AGENTS.md — moqi (moqi-tui)

## What this is

A terminal app for DeepSeek Harness: bordered composer, live token counter,
slash palette, markdown transcript with syntax-highlighted code. Published to
npm as `moqi-tui`; plugins extend it through the `tuiHost` seam.

## Commands

- `npm ci` — install (npm + lockfile; no other package manager).
- `npm run typecheck` — `tsc` against the linked Harness types.
- `npm test` — the full smoke suite (~35 suites; must pass before every commit).
- `npm run test:pty` — the pty-driven suite (CI runs it too).
- `npm run build` — emit to `lib/`.
- `npm run sonar:sync` — reconcile open Sonar issues into GitHub issues (reads
  the `SONAR_*`/`GITHUB_*` environment; `SONAR_SYNC_DRY_RUN=1` reports the plan
  and writes nothing).

## How this repo works

- Runtime: Node **>=22** (`engines`); CI matrix runs 22 and 24.
- Package manager: npm only. Zero runtime dependencies unless a milestone earns one.
- Branch model: `main`, direct commits, imperative subjects; `closes #N` in the
  body closes the issue. Work is milestone + issue driven on the GitHub tracker.
- **`lib/` is committed on purpose** — the dshfind registry inspects the tree
  and requires the manifest's `main` to exist in it. Every source change lands
  **together with its rebuilt `lib/`** (`npm run build`, then commit both).
- Typechecking depends on Harness types: run `npm run link-harness`-equivalent
  (`scripts/link-harness-types.mjs`) after `npm ci` — it symlinks the installed
  `dsh`'s `@deepseek-ai/*` packages. A clean checkout without an installed dsh
  typechecks red and tests green; that is the known shape, not a regression.
- CI: `ci.yml` (test matrix + pty), `live.yml` (round trip), `publish.yml`,
  `sonar-issues.yml` (weekly Sonar → GitHub issue sync).
- Structure: `src/index.ts` is the composition root — the cordis plugin shape
  (`name`/`inject`/`Config`/`apply`) plus the `TuiApp` class. Everything that
  reads stored sessions lives in `src/session-list.ts`, desktop bridges in
  `src/local-platform.ts`, harness→surface adapters in `src/tui-adapt.ts`,
  cross-session search in `src/cross-find.ts`, the session store layout in
  `src/sessions-store.ts`. Sonar issues are mirrored into GitHub issues by
  `scripts/sync-sonar-issues.ts`; de-duplication is the `<!-- sonar-key:… -->`
  marker each synced issue body carries.

## Conventions

- Follow the repo's existing choices; do not switch package manager, branch
  model, or test runner without asking.
- Design each module before writing it (`codebase-design`); write to the bar
  (`programming-principles`).
- Read a dependency's real source (`opensrc-source-access`) before adding or
  trusting one.
- Verify generated or untrusted code in `agent-sandbox` (`c-sandbox-1`), not on
  the laptop.
- `CONTEXT.md` is a glossary of resolved domain terms only; ADRs in `docs/adr/`
  only for hard-to-reverse, surprising decisions.
- Map code shape with exdraw into `docs/whiteboards/` after meaningful changes.
