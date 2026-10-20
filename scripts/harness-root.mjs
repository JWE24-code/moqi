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

import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
  const names = windows ? windowsCandidates(name, env) : [name]
  const searchPath = environmentValue(env, 'PATH', platform) ?? ''
  // Windows allows a PATH entry in quotes; the quotes are not part of it.
  const directories = windows
    ? searchPath.split(';').map((entry) => entry.replaceAll('"', ''))
    : searchPath.split(':')
  for (const directory of directories.filter((entry) => entry !== '')) {
    const found = names.map((candidate) => resolve(directory, candidate)).find((full) => isRunnable(full, platform))
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * The file names Windows tries for a command: the name itself when it already
 * carries a PATHEXT extension, then the name with each extension. PATHEXT is
 * upper case but npm writes `dsh.cmd`; Windows matches either, and trying the
 * lower-case spelling keeps the result the file's own.
 */
function windowsCandidates(name, env) {
  const extensions = (environmentValue(env, 'PATHEXT', 'win32') ?? DEFAULT_PATHEXT)
    .split(';')
    .filter((ext) => ext !== '')
  const hasExtension = extensions.some((ext) => name.toUpperCase().endsWith(ext.toUpperCase()))
  return [...(hasExtension ? [name] : []), ...extensions.map((ext) => name + ext.toLowerCase())]
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

// ------------------------------------------------------------ profile repair
//
// The other half of "exactly one copy of each harness package": a profile made
// before dsh 0.2.1 has a `pnpm-workspace.yaml` without `autoInstallPeers:
// false`, so pnpm installs every plugin's `@deepseek-ai/*` peers into
// `<profile>/node_modules/@deepseek-ai/`. Those copies shadow the harness's
// own and can stop dsh from starting ("required plugin did not activate",
// upstream deepseek-harness#10364). `repairProfile` fixes both halves before
// the installer's `pnpm install`: it sets the workspace key (a line edit that
// keeps everything else in the file), and it deletes the stale copies together
// with `pnpm-lock.yaml`, because pnpm restores whatever the lockfile records.
// It is idempotent: a repaired profile reports nothing.

const SCOPE = '@deepseek-ai'
const KEY = 'autoInstallPeers'
const WANTED = `${KEY}: false`

/** A top-level `autoInstallPeers:` key, bare or quoted, and what follows it. */
const KEY_LINE = /^(["']?)autoInstallPeers\1[ \t]*:(.*)$/

/** YAML 1.2 core-schema spellings of false; any other value is wrong. */
const FALSE_VALUES = new Set(['false', 'False', 'FALSE'])

/**
 * The value of a key line, without its trailing comment.
 *
 * A `#` starts a comment only after whitespace (or at the start), which is
 * all a scalar like `false` or `true` can be followed by.
 */
function valueOf(rest) {
  const comment = rest.search(/(?:^|[ \t])#/)
  return (comment === -1 ? rest : rest.slice(0, comment)).trim()
}

/**
 * Make `autoInstallPeers: false` hold in a `pnpm-workspace.yaml` text.
 *
 * Only top-level (column 0) keys count. A wrong value is replaced in place,
 * keeping its trailing comment; an absent key is appended. Line endings
 * (LF or CRLF) are kept as the file has them. A document written as a single
 * flow mapping (`{ … }`) cannot take an appended line, so it is reported as
 * `unsupported` and left alone.
 *
 * @param {string} text the file's contents
 * @returns {{ text: string, change: 'added' | 'corrected' | 'unsupported' | undefined }}
 */
export function fixWorkspaceText(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  let found = false
  let corrected = false
  const out = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const match = KEY_LINE.exec(line)
    if (match === null) {
      out.push(line)
      continue
    }
    found = true
    const rest = match[2]
    const value = valueOf(rest)
    if (FALSE_VALUES.has(value)) {
      out.push(line)
      continue
    }
    corrected = true
    const comment = rest.slice(rest.indexOf(value) + value.length).trim()
    out.push(comment.startsWith('#') ? `${WANTED} ${comment}` : WANTED)
    if (value === '') {
      // The value sat on the indented lines below the key: drop them with it.
      while (index + 1 < lines.length && /^[ \t]+\S/.test(lines[index + 1])) index += 1
    }
  }
  if (found) {
    return corrected ? { text: out.join(eol), change: 'corrected' } : { text, change: undefined }
  }
  const firstContent = lines.find((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
  if (firstContent?.trimStart().startsWith('{')) return { text, change: 'unsupported' }
  const body = text === '' || text.endsWith('\n') ? text : `${text}${eol}`
  return { text: `${body}${WANTED}${eol}`, change: 'added' }
}

/** The packages a profile manifest asks for directly, by name. */
function directDependencies(profileDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const names = new Set()
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const entries = manifest[field]
      if (entries !== null && typeof entries === 'object') {
        for (const name of Object.keys(entries)) names.add(name)
      }
    }
    return names
  } catch {
    return new Set()
  }
}

/**
 * The `@deepseek-ai/*` packages installed in a profile that it does not ask
 * for itself — the copies that shadow the harness's own. A package the
 * profile lists as a direct dependency is the user's choice and is kept.
 *
 * @param {string} profileDir
 * @returns {string[]} package names, sorted
 */
export function strayHarnessPackages(profileDir) {
  const scopeDir = join(profileDir, 'node_modules', SCOPE)
  let entries
  try {
    if (!lstatSync(scopeDir).isDirectory()) return []
    entries = readdirSync(scopeDir)
  } catch {
    return []
  }
  const direct = directDependencies(profileDir)
  return entries
    .filter((entry) => !entry.startsWith('.'))
    .map((entry) => `${SCOPE}/${entry}`)
    .filter((name) => !direct.has(name))
    .sort((a, b) => a.localeCompare(b))
}

/**
 * Repair a profile directory in place, before its `pnpm install`.
 *
 * Touches only `profileDir`: its `pnpm-workspace.yaml`, its
 * `node_modules/@deepseek-ai/` entries (symlinks are removed, never
 * followed), and its `pnpm-lock.yaml`.
 *
 * @param {string} profileDir an absolute profile directory
 * @returns {string[]} one line per repair made, empty when none was needed
 */
export function repairProfile(profileDir) {
  const notes = []

  const workspacePath = join(profileDir, 'pnpm-workspace.yaml')
  if (existsSync(workspacePath)) {
    const before = readFileSync(workspacePath, 'utf8')
    const { text, change } = fixWorkspaceText(before)
    if (change === 'added' || change === 'corrected') {
      writeFileSync(workspacePath, text)
      const what = change === 'added' ? 'added' : 'set'
      const where = change === 'added' ? 'to' : 'in'
      notes.push(
        `${what} \`${WANTED}\` ${where} pnpm-workspace.yaml — without it pnpm installs plugins' ${SCOPE}/* peers into the profile, where they shadow the harness's own`,
      )
    } else if (change === 'unsupported') {
      notes.push(
        `could not add \`${WANTED}\` to pnpm-workspace.yaml (it is a flow mapping) — add it by hand, or plugins' ${SCOPE}/* peers will shadow the harness's own`,
      )
    }
  }

  const strays = strayHarnessPackages(profileDir)
  if (strays.length > 0) {
    const scopeDir = join(profileDir, 'node_modules', SCOPE)
    for (const name of strays) {
      rmSync(join(scopeDir, name.slice(SCOPE.length + 1)), { recursive: true, force: true })
    }
    if (readdirSync(scopeDir).length === 0) rmSync(scopeDir, { recursive: true, force: true })
    const lockPath = join(profileDir, 'pnpm-lock.yaml')
    const lockNote = existsSync(lockPath) ? ' and pnpm-lock.yaml' : ''
    rmSync(lockPath, { force: true })
    notes.push(
      `removed ${String(strays.length)} stale ${SCOPE} ${strays.length === 1 ? 'copy' : 'copies'} (${strays.join(', ')})${lockNote} — they shadow the harness's own packages; the install below re-resolves without them`,
    )
  }

  return notes
}
