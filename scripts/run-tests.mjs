/**
 * `npm test`: discover the suites in `tests/` and run each in its own process.
 *
 * Adding a suite never touches package.json — name the file so the rule below
 * picks it up and it runs.
 *
 * Discovery rule: every `tests/*-smoke.ts` and `tests/*-smoke.mjs`, plus the
 * two pty suites `tests/functional.ts` and `tests/pty.ts`. Anything else in
 * `tests/` is not a suite: helpers imported by suites (`force-color.ts`), the
 * child process the pty suites drive (`pty-subject.ts`), manual tools
 * (`preview.ts`, `preview-busy.ts`, `fleet-live.ts`) and the credentialed
 * round trip (`live-pty.ts`, `npm run test:live`).
 *
 * Order: `harness-root-smoke.mjs` first (the step that lets an installed app
 * resolve its imports at all), then `offline-imports-smoke.ts` (it walks every
 * discovered suite's import graph and names the chain that reaches the
 * Harness, which a bare `npm ci` cannot load — better that report than a
 * cryptic import failure further down), then the rest sorted by file name,
 * then `functional.ts` and `pty.ts` last (the slow pseudo-terminal suites).
 *
 * `.ts` runs under `node --experimental-strip-types`, `.mjs` under plain node.
 * The run stops at the first failing suite, like the `a && b && …` chain it
 * replaces, and exits non-zero.
 *
 * Run with:
 *   node scripts/run-tests.mjs            every suite
 *   node scripts/run-tests.mjs memory     only suites whose file name contains "memory"
 *   node scripts/run-tests.mjs --list     print the discovered suites, run nothing
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

const FIRST = ['harness-root-smoke.mjs', 'offline-imports-smoke.ts']
const LAST = ['functional.ts', 'pty.ts']
const SUITE = /-smoke\.(?:ts|mjs)$/

/** The suites `npm test` runs, in run order, as `tests/<name>` paths. */
export function discoverSuites(files = readdirSync(resolve(root, 'tests'))) {
  const present = new Set(files)
  const middle = files
    .filter((name) => SUITE.test(name) && !FIRST.includes(name))
    .toSorted((a, b) => a.localeCompare(b))
  return [...FIRST.filter((n) => present.has(n)), ...middle, ...LAST.filter((n) => present.has(n))].map(
    (name) => `tests/${name}`,
  )
}

/** The node arguments that run one suite. */
function argsFor(suite) {
  return suite.endsWith('.ts') ? ['--experimental-strip-types', suite] : [suite]
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  const argv = process.argv.slice(2)
  const suites = discoverSuites()

  if (argv.includes('--list')) {
    for (const suite of suites) console.log(suite)
    process.exit(0)
  }

  const filters = argv.filter((a) => !a.startsWith('-'))
  const selected =
    filters.length === 0 ? suites : suites.filter((suite) => filters.some((f) => suite.includes(f)))
  if (selected.length === 0) {
    console.error(`run-tests: no suite matches ${filters.join(', ')}`)
    process.exit(1)
  }

  const started = Date.now()
  for (const suite of selected) {
    console.log(`\n▶ ${suite}`)
    const result = spawnSync(process.execPath, argsFor(suite), { cwd: root, stdio: 'inherit' })
    if (result.status !== 0) {
      const why = result.error?.message ?? (result.signal ? `signal ${result.signal}` : `exit ${String(result.status)}`)
      console.error(`\nFAILED: ${suite} (${why})`)
      process.exit(result.status ?? 1)
    }
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`\nok - ${String(selected.length)} suites passed in ${seconds}s`)
}
