/**
 * Offline tests for finding commands and the dsh installation on every
 * platform, including Windows simulated on any machine: `which()` and
 * `findDshRoot()` take the platform and environment as arguments, so the
 * Windows layout (an npm prefix holding `dsh.cmd` and
 * `node_modules/@deepseek-ai/dsh`) is built in a temp directory and searched
 * with `platform: 'win32'`. Also covers the dependency guard and the repair
 * of profiles made before dsh 0.2.1 (`fixWorkspaceText`, `repairProfile`).
 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dshEntry, findDshRoot, fixWorkspaceText, repairProfile, strayHarnessPackages, which } from '../scripts/harness-root.mjs'
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

// ---------------------------------------------------- fixWorkspaceText()

const CURRENT = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
check('workspace: a current file is unchanged', fixWorkspaceText(CURRENT).change === undefined)
check('workspace: unchanged text is returned as is', fixWorkspaceText(CURRENT).text === CURRENT)
check('workspace: False is false too', fixWorkspaceText('autoInstallPeers: False\n').change === undefined)
check(
  'workspace: false with a trailing comment is kept',
  fixWorkspaceText('autoInstallPeers: false # dsh 0.2.1\n').change === undefined,
)

const OLD = 'packages:\n  - .\n\nnodeLinker: hoisted\n'
const added = fixWorkspaceText(OLD)
check('workspace: an absent key is added', added.change === 'added')
check('workspace: the key is appended, the rest kept', added.text === `${OLD}autoInstallPeers: false\n`)
check(
  'workspace: no trailing newline still gives a clean line',
  fixWorkspaceText('nodeLinker: hoisted').text === 'nodeLinker: hoisted\nautoInstallPeers: false\n',
)
check('workspace: an empty file gets the key', fixWorkspaceText('').text === 'autoInstallPeers: false\n')

const commented = '# my settings\n# autoInstallPeers: true\nnodeLinker: hoisted\n  # autoInstallPeers: true\n'
const fromComments = fixWorkspaceText(commented)
check('workspace: a commented-out key does not count', fromComments.change === 'added')
check('workspace: comments are kept', fromComments.text === `${commented}autoInstallPeers: false\n`)

const truthy = 'nodeLinker: hoisted\nautoInstallPeers: true # set by me\nstrictPeerDependencies: false\n'
const flipped = fixWorkspaceText(truthy)
check('workspace: true is corrected', flipped.change === 'corrected')
check(
  'workspace: corrected in place, with its comment and neighbours',
  flipped.text === 'nodeLinker: hoisted\nautoInstallPeers: false # set by me\nstrictPeerDependencies: false\n',
)
check(
  'workspace: a quoted key is found',
  fixWorkspaceText('"autoInstallPeers": true\n').text === 'autoInstallPeers: false\n',
)
check(
  'workspace: a block value on the next line is replaced with the key',
  fixWorkspaceText('autoInstallPeers:\n  true\nnodeLinker: hoisted\n').text === 'autoInstallPeers: false\nnodeLinker: hoisted\n',
)
check(
  'workspace: a nested key is not the top-level one',
  fixWorkspaceText('catalog:\n  autoInstallPeers: true\n').text === 'catalog:\n  autoInstallPeers: true\nautoInstallPeers: false\n',
)

const crlf = 'packages:\r\n  - .\r\nnodeLinker: hoisted\r\n'
check('workspace: CRLF is kept when adding', fixWorkspaceText(crlf).text === `${crlf}autoInstallPeers: false\r\n`)
check(
  'workspace: CRLF is kept when correcting',
  fixWorkspaceText('nodeLinker: hoisted\r\nautoInstallPeers: true\r\n').text === 'nodeLinker: hoisted\r\nautoInstallPeers: false\r\n',
)
const flowText = '{ packages: [.], nodeLinker: hoisted }\n'
const flow = fixWorkspaceText(flowText)
check('workspace: a flow mapping is reported, not edited', flow.change === 'unsupported' && flow.text === flowText)

// ------------------------------------------------------- repairProfile()

/** A profile directory as dsh and `moqi install` leave it. */
function profile(name, { workspace, scoped = [], lock = true, dependencies = {} }) {
  const dir = join(sandbox, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `dsh-profile-${name}`, dependencies }))
  if (workspace !== undefined) writeFileSync(join(dir, 'pnpm-workspace.yaml'), workspace)
  if (lock) writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  for (const entry of scoped) {
    mkdirSync(join(dir, 'node_modules', '@deepseek-ai', entry), { recursive: true })
    writeFileSync(join(dir, 'node_modules', '@deepseek-ai', entry, 'package.json'), '{}')
  }
  mkdirSync(join(dir, 'node_modules', 'dsh-pii-anonymizer'), { recursive: true })
  return dir
}

const clean = profile('clean', { workspace: CURRENT })
check('repair: a current profile needs nothing', repairProfile(clean).length === 0)
check('repair: and keeps its lockfile', existsSync(join(clean, 'pnpm-lock.yaml')))

const stale = profile('stale', { workspace: OLD, scoped: ['cordis', 'dsh-tools'] })
const notes = repairProfile(stale)
check('repair: one line per repair', notes.length === 2)
check('repair: the workspace line says what and why', notes[0].includes('autoInstallPeers: false') && notes[0].includes('shadow'))
check('repair: the copies line names them', notes[1].includes('@deepseek-ai/cordis, @deepseek-ai/dsh-tools'))
check('repair: the copies line names the lockfile', notes[1].includes('pnpm-lock.yaml'))
check('repair: the key is written', readFileSync(join(stale, 'pnpm-workspace.yaml'), 'utf8') === `${OLD}autoInstallPeers: false\n`)
check('repair: the stale copies are gone', !existsSync(join(stale, 'node_modules', '@deepseek-ai')))
check('repair: the lockfile is gone', !existsSync(join(stale, 'pnpm-lock.yaml')))
check('repair: other packages are kept', existsSync(join(stale, 'node_modules', 'dsh-pii-anonymizer')))
check('repair: a second run finds nothing to do', repairProfile(stale).length === 0)

const chosen = profile('chosen', {
  workspace: CURRENT,
  scoped: ['dsh-extra', 'cordis'],
  dependencies: { '@deepseek-ai/dsh-extra': '^1.0.0' },
})
check('repair: a direct @deepseek-ai dependency is not stray', strayHarnessPackages(chosen).join() === '@deepseek-ai/cordis')
repairProfile(chosen)
check('repair: the direct dependency is kept', readdirSync(join(chosen, 'node_modules', '@deepseek-ai')).join() === 'dsh-extra')
check('repair: only the stray copy is removed', !existsSync(join(chosen, 'node_modules', '@deepseek-ai', 'cordis')))

const lockless = profile('lockless', { workspace: CURRENT, scoped: ['cordis'], lock: false })
const locklessNotes = repairProfile(lockless)
check('repair: no lockfile is not an error', locklessNotes.length === 1 && !locklessNotes[0].includes('pnpm-lock.yaml'))

const bare = profile('bare', { lock: false })
check('repair: no workspace file and no scope needs nothing', repairProfile(bare).length === 0)
check('repair: a missing workspace file is not created here', !existsSync(join(bare, 'pnpm-workspace.yaml')))

if (process.platform !== 'win32') {
  // A linked scope entry is removed as a link; its target is never followed.
  const outside = join(sandbox, 'outside-target')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'keep.txt'), 'harness')
  const linked = profile('linked', { workspace: CURRENT })
  mkdirSync(join(linked, 'node_modules', '@deepseek-ai'), { recursive: true })
  symlinkSync(outside, join(linked, 'node_modules', '@deepseek-ai', 'cordis'))
  repairProfile(linked)
  check('repair: a linked copy is unlinked', !existsSync(join(linked, 'node_modules', '@deepseek-ai', 'cordis')))
  check('repair: the link target is untouched', readFileSync(join(outside, 'keep.txt'), 'utf8') === 'harness')
}

rmSync(sandbox, { recursive: true, force: true })
console.log(`ok - ${String(checks)} install-discovery checks passed`)
