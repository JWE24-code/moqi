/**
 * Find the installed Harness and make its `@deepseek-ai` packages resolvable.
 *
 * A plugin resolves `@deepseek-ai/*` from the dsh installation anchor at
 * runtime. That works when the plugin lives inside the profile's own
 * `node_modules` — but this app is linked from wherever it was installed, so
 * Node resolves imports from the *package's* directory and never sees the
 * anchor. Linking the harness packages into the package's own `node_modules`
 * is what closes that gap, and it keeps exactly one copy of each package (the
 * harness's), which matters: a second `@deepseek-ai/cordis` would be a
 * different `Service` class.
 * @module
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The installed dsh package root.
 *
 * `DSH_INSTALL_ROOT` wins (a test or a non-standard install), else the `dsh`
 * binary on PATH is resolved and walked up to the directory owning a
 * `package.json`.
 *
 * @returns the root, or `undefined` with no throw — callers decide whether
 *   that is fatal (the installer warns) or fatal-with-help (the type linker).
 */
export function findDshRoot() {
  const fromEnvironment = process.env['DSH_INSTALL_ROOT']
  if (fromEnvironment !== undefined && existsSync(join(fromEnvironment, 'package.json'))) {
    return fromEnvironment
  }
  let binary = ''
  try {
    binary = execFileSync('/bin/sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).trim()
  } catch {
    return undefined
  }
  if (binary === '') return undefined
  let current = dirname(realpathSync(binary))
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(current, 'package.json'))) return current
    current = dirname(current)
  }
  return undefined
}

/** Where the harness's own packages live inside an installation. */
export function harnessPackageDir(dshRoot) {
  return join(dshRoot, 'node_modules', '@deepseek-ai')
}

/**
 * Make every harness `@deepseek-ai` package resolvable from `packageRoot`.
 *
 * Existing entries are replaced, so re-running is idempotent. Failures are
 * collected rather than thrown: a read-only global install should still leave
 * a working profile behind if the harness packages were resolvable some other
 * way, and the caller reports what it could not link.
 *
 * @returns the names linked and the names that failed.
 */
export function linkHarnessPackages(packageRoot, dshRoot) {
  const source = harnessPackageDir(dshRoot)
  const linked = []
  const failed = []
  if (!existsSync(source)) return { linked, failed }

  const target = join(packageRoot, 'node_modules', '@deepseek-ai')
  try {
    mkdirSync(target, { recursive: true })
  } catch {
    return { linked, failed }
  }

  for (const name of readdirSync(source)) {
    const to = join(target, name)
    try {
      rmSync(to, { recursive: true, force: true })
      symlinkSync(join(source, name), to, 'dir')
      linked.push(name)
    } catch {
      failed.push(name)
    }
  }
  return { linked, failed }
}
