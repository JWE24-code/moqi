#!/usr/bin/env node
/**
 * The `moqi` launcher: install (or refresh) the `tui` profile, then
 * hand off to `dsh --profile tui`.
 *
 * Works identically from a git checkout and a global npm install — the
 * package root is resolved from this file's own location, and the profile's
 * `link:` dependency points at whichever copy is running.
 *
 * Arguments are read before anything is written. Installing the profile
 * rewrites `$DSH_HOME/profiles/tui` and repoints it at whichever copy of the
 * package is running, so `moqi --help` used to hijack a working profile just
 * by asking what the flags were.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshEntry, findDshRoot } from '../scripts/harness-root.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const args = process.argv.slice(2)

/** The launcher's own flags, which never reach dsh and never touch the disk. */
const asks = (...names) => args.some((arg) => names.includes(arg))

if (asks('-h', '--help')) {
  const { name } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  console.log(
    [
      'moqi — the unspoken understanding between you and your harness.',
      '',
      'Usage:',
      '  moqi [dsh flags…]   install or refresh the tui profile, then start it',
      '  moqi install        install or refresh the profile and stop',
      '  moqi --help         this message',
      '  moqi --version      the installed version',
      '',
      'Flags other than these are passed to dsh, so the app\'s own options',
      '(--resume, --model, --thinking, --mouse, --peer, …) work as documented.',
      'For that list, run:  dsh --profile tui --help',
      '',
      `Installed from ${name}; the profile it manages is $DSH_HOME/profiles/tui.`,
    ].join('\n'),
  )
  process.exit(0)
}

if (asks('-v', '--version')) {
  const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  console.log(version)
  process.exit(0)
}

const command = args[0] === 'install' ? 'install' : 'run'

/**
 * How to start dsh: `DSH_BIN` when set, else this Node running dsh's own bin
 * script, else plain `dsh` from PATH.
 *
 * Running the script directly is what makes Windows work: npm's `dsh` there is
 * a `.cmd` shim, which Node refuses to spawn without a shell.
 *
 * @returns the file to execute and the arguments that go before dsh's own.
 */
function dshCommand() {
  const override = process.env['DSH_BIN']
  if (override !== undefined && override !== '') return [override, []]
  const dshRoot = findDshRoot()
  const entry = dshRoot === undefined ? undefined : dshEntry(dshRoot)
  return entry === undefined ? ['dsh', []] : [process.execPath, [entry]]
}

try {
  // The installer is plain Node with no build step, so it runs from source.
  execFileSync(process.execPath, [resolve(root, 'scripts', 'install-profile.mjs'), 'tui'], {
    stdio: 'inherit',
  })
} catch {
  process.exit(1)
}

if (command === 'install') {
  console.log('moqi: profile installed — start it with `dsh --profile tui`')
  process.exit(0)
}

// Hand the terminal over to dsh itself; the exit code is the app's.
try {
  const [file, prefix] = dshCommand()
  execFileSync(file, [...prefix, '--profile', 'tui', ...args], { stdio: 'inherit' })
} catch (error) {
  process.exitCode = typeof error?.status === 'number' ? error.status : 1
}
