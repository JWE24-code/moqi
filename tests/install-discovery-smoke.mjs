/**
 * Offline tests for finding commands and the dsh installation on every
 * platform, including Windows simulated on any machine: `which()` and
 * `findDshRoot()` take the platform and environment as arguments, so the
 * Windows layout (an npm prefix holding `dsh.cmd` and
 * `node_modules/@deepseek-ai/dsh`) is built in a temp directory and searched
 * with `platform: 'win32'`. Also covers the dependency guard.
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dshEntry, findDshRoot, which } from '../scripts/harness-root.mjs'
import { harnessDependencies } from '../scripts/check-harness-deps.mjs'

let checks = 0
function check(label, condition) {
  assert.ok(condition, label)
  checks += 1
}

const sandbox = mkdtempSync(join(tmpdir(), 'moqi-install-discovery-'))

/** A dsh package directory with its manifest and bin script. */
function dshPackage(root) {
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', bin: { dsh: 'lib/bin.js' } }),
  )
  writeFileSync(join(root, 'lib', 'bin.js'), '#!/usr/bin/env node\n')
  chmodSync(join(root, 'lib', 'bin.js'), 0o755)
  return root
}

// ------------------------------------------------------- which() on win32

const winPrefix = join(sandbox, 'win', 'npm')
const winOther = join(sandbox, 'win', 'other')
mkdirSync(winPrefix, { recursive: true })
mkdirSync(winOther, { recursive: true })
writeFileSync(join(winPrefix, 'dsh.cmd'), '@echo off\n')
// npm also writes an extensionless sh shim next to the .cmd; Windows never
// runs it from PATH, so which() must not return it.
writeFileSync(join(winPrefix, 'dsh'), '#!/bin/sh\n')
writeFileSync(join(winOther, 'tool.exe'), '')
const winRoot = dshPackage(join(winPrefix, 'node_modules', '@deepseek-ai', 'dsh'))

const winEnv = { Path: `"${winOther}";${winPrefix}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
const win = { platform: 'win32', env: winEnv }
check('win32: dsh resolves to the .cmd shim', which('dsh', win) === join(winPrefix, 'dsh.cmd'))
check('win32: PATH is read case-insensitively and quotes are dropped', which('tool', win) === join(winOther, 'tool.exe'))
check('win32: an explicit extension is found as is', which('dsh.cmd', win) === join(winPrefix, 'dsh.cmd'))
check('win32: a missing command is undefined', which('pnpm', win) === undefined)
check(
  'win32: PATHEXT defaults when unset',
  which('dsh', { platform: 'win32', env: { PATH: winPrefix } }) === join(winPrefix, 'dsh.cmd'),
)
check('win32: no PATH finds nothing', which('dsh', { platform: 'win32', env: {} }) === undefined)

// ------------------------------------------------- findDshRoot() on win32

check('win32: the root is <prefix>/node_modules/@deepseek-ai/dsh', findDshRoot(win) === winRoot)
check('win32: the entry is the bin script', dshEntry(winRoot) === join(winRoot, 'lib', 'bin.js'))
const bareWin = join(sandbox, 'win-bare')
mkdirSync(bareWin, { recursive: true })
writeFileSync(join(bareWin, 'dsh.cmd'), '')
check(
  'win32: a shim with no package beside it gives undefined',
  findDshRoot({ platform: 'win32', env: { PATH: bareWin } }) === undefined,
)
check(
  'win32: DSH_INSTALL_ROOT still wins',
  findDshRoot({ platform: 'win32', env: { DSH_INSTALL_ROOT: winRoot, PATH: '' } }) === winRoot,
)

// ------------------------------------------------- POSIX layout (symlink)

if (process.platform !== 'win32') {
  const prefix = join(sandbox, 'posix')
  const posixRoot = dshPackage(join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
  mkdirSync(join(prefix, 'bin'), { recursive: true })
  symlinkSync(join(posixRoot, 'lib', 'bin.js'), join(prefix, 'bin', 'dsh'))
  writeFileSync(join(prefix, 'bin', 'not-executable'), '')
  const posix = { platform: 'linux', env: { PATH: `${join(sandbox, 'nowhere')}::${join(prefix, 'bin')}` } }
  check('posix: dsh resolves to the bin link', which('dsh', posix) === join(prefix, 'bin', 'dsh'))
  check('posix: a non-executable file is skipped', which('not-executable', posix) === undefined)
  check('posix: the root is found by walking up from the link target', findDshRoot(posix) === posixRoot)
}

// -------------------------------------------------------------- dshEntry()

const foreign = join(sandbox, 'foreign')
mkdirSync(foreign, { recursive: true })
writeFileSync(join(foreign, 'package.json'), JSON.stringify({ name: 'mise', bin: { dsh: 'x.js' } }))
writeFileSync(join(foreign, 'x.js'), '')
check('dshEntry ignores a package that is not dsh', dshEntry(foreign) === undefined)
const stringBin = join(sandbox, 'string-bin')
mkdirSync(stringBin, { recursive: true })
writeFileSync(join(stringBin, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', bin: 'cli.js' }))
writeFileSync(join(stringBin, 'cli.js'), '')
check('dshEntry accepts a string bin', dshEntry(stringBin) === join(stringBin, 'cli.js'))
check('dshEntry is undefined when the script is missing', dshEntry(join(sandbox, 'nowhere')) === undefined)

// ------------------------------------------------------------ deps guard

check('the guard flags a harness runtime dependency', harnessDependencies({ dependencies: { '@deepseek-ai/cordis': '*', commander: '1' } }).join() === '@deepseek-ai/cordis')
check('the guard allows harness peers', harnessDependencies({ dependencies: { commander: '1' }, peerDependencies: { '@deepseek-ai/cordis': '*' } }).length === 0)
check('the guard tolerates no dependencies', harnessDependencies({}).length === 0)

rmSync(sandbox, { recursive: true, force: true })
console.log(`ok - ${String(checks)} install-discovery checks passed`)
