/**
 * Regression tests for harness-root linking: the step that makes a freshly
 * installed app able to resolve its `@deepseek-ai/*` imports at all.
 *
 * Plain JS like the module under test (scripts/*.mjs are shipped as-is, with
 * no build step).
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findDshRoot, harnessPackageDir, linkHarnessPackages } from '../scripts/harness-root.mjs'

let checks = 0
function check(label, condition) {
  assert.ok(condition, label)
  checks += 1
}

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-harness-root-'))

/** A fake dsh installation: a package.json plus a few @deepseek-ai packages. */
function fakeDsh(name) {
  const root = join(sandbox, name)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))
  for (const pkg of ['cordis', 'dsh-llm', 'schemastery']) {
    const dir = join(root, 'node_modules', '@deepseek-ai', pkg)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${pkg}` }))
  }
  return root
}

// ------------------------------------------------------------ discovery

const dshRoot = fakeDsh('install')
const previous = process.env['DSH_INSTALL_ROOT']

process.env['DSH_INSTALL_ROOT'] = dshRoot
check('DSH_INSTALL_ROOT is honoured', findDshRoot() === dshRoot)

process.env['DSH_INSTALL_ROOT'] = join(sandbox, 'does-not-exist')
// With no usable override it falls back to PATH; in a sandbox that may find a
// real dsh, so the assertion is only that it never throws and never returns
// the bogus path.
check('a bogus override is ignored', findDshRoot() !== join(sandbox, 'does-not-exist'))

if (previous === undefined) delete process.env['DSH_INSTALL_ROOT']
else process.env['DSH_INSTALL_ROOT'] = previous

check('the harness package directory is under node_modules', harnessPackageDir(dshRoot).endsWith(join('node_modules', '@deepseek-ai')))

// ------------------------------------------------------------- linking

const appRoot = join(sandbox, 'app')
mkdirSync(appRoot, { recursive: true })
const { linked, failed } = linkHarnessPackages(appRoot, dshRoot)
check('every harness package is linked', linked.length === 3)
check('nothing failed', failed.length === 0)
check('a link resolves to the harness copy', existsSync(join(appRoot, 'node_modules', '@deepseek-ai', 'cordis')))
check('the harness package directory is unchanged', readdirSync(join(dshRoot, 'node_modules', '@deepseek-ai')).length === 3)

// Linking again must be idempotent rather than nesting symlinks.
const second = linkHarnessPackages(appRoot, dshRoot)
check('relinking is idempotent', second.linked.length === 3 && second.failed.length === 0)

// An installation with no @deepseek-ai tree links nothing and does not throw.
const emptyDsh = join(sandbox, 'empty')
mkdirSync(emptyDsh, { recursive: true })
writeFileSync(join(emptyDsh, 'package.json'), '{}')
const empty = linkHarnessPackages(join(sandbox, 'app2'), emptyDsh)
check('a bare installation links nothing', empty.linked.length === 0 && empty.failed.length === 0)

// A pre-existing real directory where the link goes is replaced, not merged.
const blockedDsh = fakeDsh('install2')
const blockedRoot = join(sandbox, 'app3')
mkdirSync(join(blockedRoot, 'node_modules', '@deepseek-ai', 'cordis'), { recursive: true })
const blocked = linkHarnessPackages(blockedRoot, blockedDsh)
check('an existing directory is replaced by the link', blocked.linked.length === 3)

rmSync(sandbox, { recursive: true, force: true })
console.log(`ok - ${String(checks)} harness-root checks passed`)
