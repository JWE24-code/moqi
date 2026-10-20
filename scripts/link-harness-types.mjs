/**
 * Link the installed `dsh` runtime's own @deepseek-ai packages into this
 * project's node_modules, so `tsc` typechecks against the exact Harness build
 * the plugin will run under.
 *
 * The Harness resolves a plugin's @deepseek-ai imports from the dsh
 * installation anchor at runtime, which is why they are optional peers here
 * rather than dependencies. Typechecking needs the same files on disk, so this
 * finds the installation and links them — with the same discovery and linking
 * the installer uses (`harness-root.mjs`), so both work on every platform.
 *
 * Run with: node scripts/link-harness-types.mjs
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { findDshRoot, harnessPackageDir, linkHarnessPackages } from './harness-root.mjs'

const dshRoot = findDshRoot()
if (dshRoot === undefined) {
  console.error('link-harness-types: no `dsh` installation found. Install it with: npm install -g @deepseek-ai/dsh')
  console.error('link-harness-types: or set DSH_INSTALL_ROOT to the @deepseek-ai/dsh package directory.')
  process.exit(1)
}

const source = harnessPackageDir(dshRoot)
if (!existsSync(source)) {
  console.error(`link-harness-types: ${source} does not exist; is this a complete dsh install?`)
  process.exit(1)
}

const { linked, failed } = linkHarnessPackages(resolve(import.meta.dirname, '..'), dshRoot)
for (const name of failed) console.error(`link-harness-types: could not link ${name}`)

console.log(`link-harness-types: linked ${String(linked.length)} packages from ${dshRoot}`)
