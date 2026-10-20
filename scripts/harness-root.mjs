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

import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, realpathSync, statSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** The default for `PATHEXT` when Windows leaves it unset. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/**
 * Read an environment variable the way the platform does: Windows treats
 * names case-insensitively (`Path` and `PATH` are the same variable), POSIX
 * does not.
 */
function environmentValue(env, name, platform) {
  if (platform !== 'win32') return env[name]
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}

/** Whether `path` is a file this platform would run from PATH. */
function isRunnable(path, platform) {
  try {
    if (!statSync(path).isFile()) return false
    if (platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Find a command on PATH, the way a shell would, without spawning one.
 *
 * On Windows each PATH entry is tried with every `PATHEXT` extension, so
 * `which('npm')` finds `npm.cmd`; elsewhere the file must be executable.
 * `platform` and `env` are injectable so either behaviour can be tested on
 * any machine.
 *
 * @returns the absolute path of the first match, or `undefined`.
 */
export function which(name, { platform = process.platform, env = process.env } = {}) {
  const windows = platform === 'win32'
  const searchPath = environmentValue(env, 'PATH', platform) ?? ''
  const extensions = windows
    ? (environmentValue(env, 'PATHEXT', platform) ?? DEFAULT_PATHEXT).split(';').filter((ext) => ext !== '')
    : []
  const hasExtension = windows && extensions.some((ext) => name.toUpperCase().endsWith(ext.toUpperCase()))
  // PATHEXT is upper case but npm writes `dsh.cmd`; Windows matches either,
  // and trying the lower-case spelling first keeps the result the file's own.
  const names = windows
    ? [...(hasExtension ? [name] : []), ...extensions.map((ext) => name + ext.toLowerCase())]
    : [name]
  for (const entry of searchPath.split(windows ? ';' : ':')) {
    // Windows allows a PATH entry in quotes; the quotes are not part of it.
    const directory = windows ? entry.replaceAll('"', '') : entry
    if (directory === '') continue
    for (const candidate of names) {
      const full = resolve(directory, candidate)
      if (isRunnable(full, platform)) return full
    }
  }
  return undefined
}

/**
 * The installed dsh package root.
 *
 * `DSH_INSTALL_ROOT` wins (a test or a non-standard install), else the `dsh`
 * command on PATH is found. On Windows npm installs a `dsh.cmd` shim in the
 * npm prefix, with the package at `<prefix>/node_modules/@deepseek-ai/dsh`;
 * elsewhere the bin is a symlink into the package, resolved and walked up to
 * the directory owning a `package.json`.
 *
 * @returns the root, or `undefined` with no throw — callers decide whether
 *   that is fatal (the installer warns) or fatal-with-help (the type linker).
 */
export function findDshRoot({ platform = process.platform, env = process.env } = {}) {
  const fromEnvironment = env['DSH_INSTALL_ROOT']
  if (fromEnvironment !== undefined && existsSync(join(fromEnvironment, 'package.json'))) {
    return fromEnvironment
  }
  const binary = which('dsh', { platform, env })
  if (binary === undefined) return undefined
  if (platform === 'win32') {
    const root = join(dirname(binary), 'node_modules', '@deepseek-ai', 'dsh')
    return existsSync(join(root, 'package.json')) ? root : undefined
  }
  let current = dirname(realpathSync(binary))
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(current, 'package.json'))) return current
    current = dirname(current)
  }
  return undefined
}

/**
 * The script the `dsh` command runs, as an absolute path, read from the
 * package's own `bin` field.
 *
 * Running `node <this>` starts dsh without going through npm's shim, which on
 * Windows is a `.cmd` file Node refuses to spawn without a shell.
 *
 * @returns the entry, or `undefined` if the manifest names none that exists.
 */
export function dshEntry(dshRoot) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(dshRoot, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
  // A PATH walk can land on some other package (a version manager's shim);
  // only dsh's own manifest names the script to run.
  if (manifest?.name !== '@deepseek-ai/dsh') return undefined
  const bin = manifest.bin
  const relative = typeof bin === 'string' ? bin : bin?.dsh
  if (typeof relative !== 'string') return undefined
  const entry = join(dshRoot, relative)
  return existsSync(entry) ? entry : undefined
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
export function linkHarnessPackages(packageRoot, dshRoot, { platform = process.platform } = {}) {
  const source = harnessPackageDir(dshRoot)
  // A junction needs no Developer Mode or elevation on Windows, where a
  // directory symlink does; POSIX ignores the type argument.
  const type = platform === 'win32' ? 'junction' : 'dir'
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
      symlinkSync(join(source, name), to, type)
      linked.push(name)
    } catch {
      failed.push(name)
    }
  }
  return { linked, failed }
}
