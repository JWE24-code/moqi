# Sonar issue resolution plan

All **17 open GitHub issues** on `JWE24-code/moqi` are auto-synced SonarCloud
findings (labels `sonar`, `sonar:critical`). They are produced by
`.github/workflows/sonar-issues.yml` → `scripts/sync-sonar-issues.ts`, which
opens one GitHub issue per unresolved Sonar issue and closes it again when
Sonar resolves it. De-duplication is the `<!-- sonar-key:… -->` marker.

The 17 issues are **4 distinct root causes**. Two of the four are in `lib/`
compiled output that duplicates its `src/` finding.

## Triage

| # | Rule | Type | Location | Verdict |
|---|------|------|----------|---------|
| 30 | `typescript:S1143` | BUG | `src/turn-runner.ts:216` | **Real — fix** |
| 29 | `javascript:S1143` | BUG | `lib/turn-runner.js:145` | Duplicate of #30 (`lib/`) |
| 45 | `typescript:S2871` | BUG | `src/plugins.ts:245` | **Real lint — fix** |
| 34 | `typescript:S2871` | BUG | `src/tui/mcp.ts:62` | **Real lint — fix** |
| 33 | `javascript:S2871` | BUG | `lib/tui/mcp.js:61` | Duplicate of #34 (`lib/`) |
| 32 | `javascript:S2871` | BUG | `lib/plugins.js:161` | Duplicate of #45 (`lib/`) |
| 44 | `typescript:S5443` | VULN | `tests/voice-smoke.ts:331` | False positive |
| 43 | `typescript:S5443` | VULN | `tests/voice-smoke.ts:326` | False positive |
| 42 | `typescript:S5443` | VULN | `tests/voice-smoke.ts:322` | False positive |
| 41 | `typescript:S5443` | VULN | `tests/voice-smoke.ts:130` | False positive |
| 40 | `typescript:S5443` | VULN | `tests/voice-smoke.ts:129` | False positive |
| 39 | `typescript:S5443` | VULN | `tests/voice-smoke.ts:110` | False positive |
| 38 | `typescript:S5443` | VULN | `tests/voice-smoke.ts:100` | False positive |
| 37 | `typescript:S5443` | VULN | `tests/voice-smoke.ts:91` | False positive |
| 36 | `typescript:S5443` | VULN | `tests/voice-smoke.ts:77` | False positive |
| 35 | `typescript:S5443` | VULN | `tests/voice-smoke.ts:76` | False positive |
| 31 | `typescript:S5443` | VULN | `tests/osc52-smoke.ts:46` | False positive |

## Finding 1 — S1143, `return` inside `finally` (real bug)

Rule: [Jump statements should not occur in "finally" blocks](https://rules.sonarsource.com/typescript/rspec-1143/).

`src/turn-runner.ts:216` returns from inside the `finally` of `sendTo`. A jump
statement in `finally` swallows any exception or pending return from the
`try`/`catch`, so a failure can be silently discarded. That is a real
reliability defect, and it is the only genuinely correctness-class finding in
the set.

The `return` exists only to skip the trailing `this.host.repaint()` on line 224
after the drain branch already called `repaint()` on line 215. Because the
drain branch is the only path that returns, and the trailing `if (!drain …)`
status block is already false whenever `drain` is true, the branch can simply
fall through to the single trailing `repaint()`.

**Fix** (minimal, behavior-preserving):

```ts
if (drain && tab.queued.length > 0) {
  const next = tab.queued.shift()
  if (next !== undefined) {
    void this.sendTo(tab, next, true)
  }
}
if (!drain && tab.queued.length > 0 && this.host.isForeground(tab)) {
  this.host.status(/* unchanged */)
}
this.host.repaint()
```

Delete the inner `this.host.repaint()` and `return`. `sendTo` is fire-and-
forget (`void`), so removing the duplicate repaint leaves exactly one repaint
per path, in the same order. Then rebuild `lib/` to clear #29.

## Finding 2 — S2871, `sort()` without a comparator (real lint, not a runtime bug)

Rule: SonarJS S2871. `[...dependencies.keys()].sort()` (`src/plugins.ts:245`)
and `[...tools].sort()` (`src/tui/mcp.ts:62`) rely on the default UTF-16
lexicographic sort. Both inputs are constrained ASCII strings, so the current
ordering is already deterministic and correct — this is a **maintainability**
finding, not the "BUG/CRITICAL" a reader might assume.

Sonar asks specifically for `String.localeCompare` on the two `src/` instances.
Add it, matching the style already used for server names on `src/tui/mcp.ts:63`:

```ts
// src/plugins.ts:245
for (const packageName of [...dependencies.keys()].sort((a, b) => a.localeCompare(b))) {

// src/tui/mcp.ts:62
.map(([name, tools]) => ({ name, tools: [...tools].sort((a, b) => a.localeCompare(b)) }))
```

Then rebuild `lib/` to clear #32 and #33. Existing assertions use ASCII names
(`a`/`b`/`alpha`/`files`/`zeta`) and package presence only, so `mcp-smoke` and
`plugins-smoke` remain green. One behavior note: `localeCompare` is
locale-sensitive, so the *disabled* package ordering in the plugin picker could
differ from code-unit order for scoped `@scope/name` entries — acceptable for an
alphabetical list, but worth a glance in review.

## Finding 3 — S5443, `/tmp` string literals in tests (false positive)

Rule: [Publicly writable directories should be used safely](https://rules.sonarsource.com/typescript/rspec-5443/).
All 11 hits are `/tmp/...` string **literals** passed to pure functions or used
as env-map values:

- `tests/voice-smoke.ts` — `/tmp/a.wav` passed to `recorder.args()` /
  `whisperArgs()`, and used in `args.includes(...)` assertions. No filesystem call.
- `tests/osc52-smoke.ts:46` — `TMUX: '/tmp/tmux-1000/default,1234,0'`, a realistic
  env value; the test only checks the wrapper prefix.

Nothing here creates or opens a file in a world-writable directory, so the
vulnerability reading is wrong.

**Recommended resolution (in-repo, no SonarCloud clicks):** replace the
incidental `/tmp/a.wav` literals in `voice-smoke.ts` with `/home/tester/a.wav`,
matching the suite's existing `probe(..., home = '/home/tester')` fixture, and
change the `osc52-smoke.ts` `TMUX` fixture to a non-`/tmp` path such as
`/home/tester/tmux/default,1234,0`. Both are opaque strings to the code under
test; behavior and assertions are unchanged, and the rule stops firing after the
next analysis.

**Alternative:** mark all 11 as *False Positive* in SonarCloud. That is the
semantically exact action, but it requires UI access and the GitHub issues only
close on the next weekly sync. Prefer the fixture rename unless the tmux path
realism is considered load-bearing.

## Finding 4 — `lib/` is analyzed, doubling every source finding

`lib/` is committed on purpose (the dshfind registry inspects the tree), but it
is also analyzed by Sonar, so every `src/` finding reappears against its compiled
JS (#29, #32, #33). Fixing `src/` and rebuilding clears those three, but the
duplication returns with the next finding.

**Resolution:** exclude `lib/**` from Sonar analysis. The repo has no
`sonar-project.properties`, so the project is almost certainly using SonarCloud
Automatic Analysis, where exclusions live in the UI (Administration → General
Settings → Analysis Scope → Source File Exclusions). Add `lib/**`. If the team
moves to CI-based analysis, commit a `sonar-project.properties` instead so the
exclusion is versioned.

## Execution order

1. Fix S1143 in `src/turn-runner.ts` (real defect).
2. Add comparators in `src/plugins.ts` and `src/tui/mcp.ts`.
3. Replace the `/tmp` fixtures in `tests/voice-smoke.ts` and `tests/osc52-smoke.ts`.
4. `npm run typecheck && npm test` (and `npm run test:pty` if CI is the gate).
5. `npm run build` and commit `lib/` together with `src/` and `tests/`.
6. Add `lib/**` to Sonar exclusions.
7. Verify: `SONAR_SYNC_DRY_RUN=1 npm run sonar:sync` reports no unresolved
   findings for the touched rules; the weekly sync closes the mapped issues.

## Issue closure map

- Commit fixing `src/turn-runner.ts` + `lib/` → closes #30, #29.
- Commit fixing `src/plugins.ts`, `src/tui/mcp.ts` + `lib/` → closes #45, #34, #32, #33.
- Commit fixing test fixtures → closes #31, #35, #36, #37, #38, #39, #40, #41, #42, #43, #44.
- Sonar exclusion for `lib/**` → prevents recurrence of #29/#32/#33 class.

## Effort

Small: ~1–2 hours, one commit/PR. Only Finding 1 warrants care; Findings 2–4 are
mechanical. No runtime dependencies or public API changes.
