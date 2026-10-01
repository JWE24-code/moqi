/**
 * Link the installed `dsh` runtime's own @deepseek-ai packages into this
 * project's node_modules, so `tsc` typechecks against the exact Harness build
 * the plugin will run under.
 *
 * The Harness resolves a plugin's @deepseek-ai imports from the dsh
 * installation anchor at runtime, which is why they are optional peers here
 * rather than dependencies. Typechecking needs the same files on disk, so this
 * finds the installation and symlinks them.
 *
 * Run with: node scripts/link-harness-types.mjs
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, rmSync, symlinkSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Locate the installed dsh package root, or exit with a clear message. */
function findDshRoot() {
  const fromEnvironment = process.env.DSH_INSTALL_ROOT
  if (fromEnvironment !== undefined && existsSync(join(fromEnvironment, 'package.json'))) {
    return fromEnvironment
  }

  let binary
  try {
    binary = execFileSync('/bin/sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).trim()
  } catch {
    binary = ''
  }
  if (binary === '') {
    console.error('link-harness-types: no `dsh` on PATH. Install it with: npm install -g @deepseek-ai/dsh')
    console.error('link-harness-types: or set DSH_INSTALL_ROOT to the @deepseek-ai/dsh package directory.')
    process.exit(1)
  }

  // The bin is a symlink into the package's lib/; resolve it and walk up to
  // the directory that owns package.json.
  let current = dirname(realpathSync(binary))
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(current, 'package.json'))) return current
    current = dirname(current)
  }
  console.error(`link-harness-types: could not find the dsh package root above ${binary}`)
  process.exit(1)
}

const dshRoot = findDshRoot()
const source = join(dshRoot, 'node_modules', '@deepseek-ai')
if (!existsSync(source)) {
  console.error(`link-harness-types: ${source} does not exist; is this a complete dsh install?`)
  process.exit(1)
}

const target = resolve(import.meta.dirname, '..', 'node_modules', '@deepseek-ai')
mkdirSync(target, { recursive: true })

let linked = 0
for (const name of readdirSync(source)) {
  const from = join(source, name)
  const to = join(target, name)
  try {
    rmSync(to, { recursive: true, force: true })
    symlinkSync(from, to, 'dir')
    linked += 1
  } catch (error) {
    console.error(`link-harness-types: could not link ${name}: ${error.message}`)
  }
}

console.log(`link-harness-types: linked ${linked} packages from ${dshRoot}`)
