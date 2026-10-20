/**
 * The invariant `npm test` rests on: nothing it loads may import the Harness.
 *
 * CI runs the suites from a bare `npm ci`, where `@deepseek-ai/*` does not
 * resolve — but a development checkout has run `npm run link-types`, so there
 * the same import resolves fine. A suite that reaches into the Harness is
 * therefore invisible locally and fails only on push, which is how
 * `tests/tui-host-smoke.ts` kept CI red for sixteen commits.
 *
 * This walks the import graph of every suite `npm test` actually runs, asking
 * the runner (`scripts/run-tests.mjs --list`) for the entry points so the two
 * lists cannot drift apart, and names the chain when one reaches the Harness.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const show = (file: string): string => relative(root, file)

/** Specifiers a module pulls in: static, side-effect, re-export, and dynamic. */
function importsOf(source: string): string[] {
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  return patterns.flatMap((re) => [...source.matchAll(re)].map((m) => m[1]!))
}

/**
 * The suites `npm test` runs, in order.
 *
 * `tests/pty-subject.ts` is added by hand: `pty.ts` runs it as a child process
 * under script(1) rather than importing it, so no static walk can find it.
 */
function entryPoints(): string[] {
  const listed = execFileSync(process.execPath, [resolve(root, 'scripts/run-tests.mjs'), '--list'], {
    cwd: root,
    encoding: 'utf8',
  })
  const found = listed.split('\n').filter((line) => line.startsWith('tests/'))
  assert.ok(found.length > 0, 'the runner discovers at least one suite')
  return [...new Set([...found, 'tests/pty-subject.ts'])].map((p) => resolve(root, p))
}

let checks = 0
function check(label: string, condition: boolean): void {
  assert.ok(condition, label)
  checks += 1
}

const entries = entryPoints()
check('every suite the runner discovers exists', entries.every((f) => existsSync(f)))

// Breadth-first over relative imports, remembering how each module was reached
// so a violation can be reported as a chain rather than a bare file name.
const origin = new Map<string, string[]>(entries.map((f) => [f, [f]]))
const queue = [...entries]
const walked: string[] = []
const violations: string[] = []

while (queue.length > 0) {
  const file = queue.shift()!
  walked.push(file)
  const chain = origin.get(file)!
  const source = readFileSync(file, 'utf8')

  for (const spec of importsOf(source)) {
    if (spec.startsWith('@deepseek-ai/')) {
      // A module may name the same package twice (a value and a type import);
      // the chain that reached it is the finding, so report each chain once.
      const found = [...chain.map(show), spec].join(' → ')
      if (!violations.includes(found)) violations.push(found)
      continue
    }
    // Bare specifiers are node: builtins and real dependencies; only relative
    // imports lead back into this package, so only those are followed.
    if (!spec.startsWith('.')) continue
    const target = resolve(dirname(file), spec)
    if (!existsSync(target) || origin.has(target)) continue
    origin.set(target, [...chain, target])
    queue.push(target)
  }
}

check(
  'no suite reaches the Harness',
  violations.length === 0 ||
    // assert.ok prints the label, not the detail, so name the chains first.
    (console.error(`\nreached @deepseek-ai from:\n  ${violations.join('\n  ')}\n`), false),
)

// A walker that silently resolved nothing would pass the check above without
// having proved anything, so hold it to a graph of a realistic size.
check('the walk reached the modules under test', walked.length > 40)
check('the walk followed suites into src/', walked.some((f) => show(f).startsWith('src/')))
check(
  'the framework-free half of the tuiHost seam is what its suite imports',
  origin.has(resolve(root, 'src/tui-host-core.ts')) && !origin.has(resolve(root, 'src/tui-host.ts')),
)

console.log(`ok - ${String(checks)} offline-import checks passed (${String(walked.length)} modules)`)
