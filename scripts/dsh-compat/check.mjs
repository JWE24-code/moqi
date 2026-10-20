#!/usr/bin/env node
/**
 * Check step of the dsh compatibility watch: with dsh, pnpm and one source's
 * moqi already installed globally, give every target a fresh DSH_HOME and
 * check that it installs, boots, and carries no stale harness copies.
 *
 * "Boots" is checked by starting the profile without a terminal and watching
 * it: a healthy profile keeps running (it waits for input), while a profile
 * whose plugins fail to activate exits within seconds with
 * `dsh: startup failed` (deepseek-harness #10364). Moqi's own profile refuses
 * to run without a terminal, so on Linux it is booted inside `script`.
 *
 * Usage: check.mjs --source published|main --out results.json
 * Environment: DSH_VERSION, MOQI_ROOT (the installed moqi-tui directory),
 * PLUGIN_SPECS (JSON: plugin name → what `dsh plugin add` gets), RUNNER_TEMP,
 * MATRIX_OS.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { dshEntry, findDshRoot } from '../harness-root.mjs'

const { values } = parseArgs({ options: { source: { type: 'string' }, out: { type: 'string' } } })
const source = values.source
const out = values.out
if (source === undefined || out === undefined) {
  console.error('usage: check.mjs --source published|main --out results.json')
  process.exit(2)
}

const version = process.env.DSH_VERSION ?? 'unknown'
const os = process.env.MATRIX_OS ?? process.platform
const temp = process.env.RUNNER_TEMP ?? join(process.cwd(), '.dsh-compat')
const specs = JSON.parse(process.env.PLUGIN_SPECS ?? '{}')
const plugins = ['dsh-jev-loop', 'dsh-pii-anonymizer', 'moqi-jev-loop']

const dshRoot = findDshRoot()
const dsh = dshRoot === undefined ? undefined : dshEntry(dshRoot)
if (dsh === undefined) {
  console.error('check: no dsh installation found')
  process.exit(2)
}
const moqi = join(process.env.MOQI_ROOT ?? '', 'bin', 'moqi.mjs')

/** A failed step: which one, and the tail of what it printed. */
class StepFailure extends Error {
  constructor(step, detail) {
    super(step)
    this.step = step
    this.detail = detail
  }
}

const tail = (text, size = 1500) => (text.length > size ? `…${text.slice(-size)}` : text)

/** Run a node script to completion; throw a StepFailure when it fails. */
function run(step, script, args, home) {
  const result = spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  })
  if (result.status !== 0) {
    throw new StepFailure(step, tail(`${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}`))
  }
  return `${result.stdout}${result.stderr}`
}

/** Start a profile and require it to still be running after `seconds`. */
function boot(step, profile, home, seconds = 30) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [dsh, '--profile', profile], {
      env: { ...process.env, DSH_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    const timer = setTimeout(() => {
      child.kill()
      if (output.includes('startup failed')) reject(new StepFailure(step, tail(output)))
      else resolve(output)
    }, seconds * 1000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new StepFailure(step, tail(`exited early with ${String(code)}\n${output}`)))
    })
  })
}

/** Boot moqi's own profile inside a pseudo-terminal (Linux only). */
function bootInTerminal(step, home, seconds = 30) {
  return new Promise((resolve, reject) => {
    const command = `stty rows 40 cols 120; exec "${process.execPath}" "${dsh}" --profile tui --no-restore`
    const child = spawn('script', ['-qec', command, '/dev/null'], {
      env: { ...process.env, DSH_HOME: home, TERM: 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    const timer = setTimeout(() => {
      process.kill(-child.pid, 'SIGKILL')
      if (output.includes('startup failed') || !output.includes('moqi')) reject(new StepFailure(step, tail(output)))
      else resolve(output)
    }, seconds * 1000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new StepFailure(step, tail(`exited early with ${String(code)}\n${output}`)))
    })
  })
}

/** No `@deepseek-ai/*` copies may sit in the profile (deepseek-harness #10364). */
function noStaleCopies(home, profile) {
  const dir = join(home, 'profiles', profile, 'node_modules', '@deepseek-ai')
  const found = existsSync(dir) ? readdirSync(dir) : []
  if (found.length > 0) throw new StepFailure('stale harness copies', found.join(', '))
}

/** A fresh, empty DSH_HOME for one target. */
function freshHome(target) {
  const home = join(temp, `dsh-home-${source}-${target}`)
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  return home
}

const addPlugin = (home, profile, name) => run(`dsh plugin add ${name}`, dsh, ['plugin', '--profile', profile, 'add', specs[name]], home)

const checks = {
  'moqi-tui': async () => {
    const home = freshHome('moqi-tui')
    run('moqi install', moqi, ['install'], home)
    run('dsh --dump-config', dsh, ['--profile', 'tui', '--dump-config'], home)
    noStaleCopies(home, 'tui')
    if (process.platform === 'linux') await bootInTerminal('boot moqi (pty)', home)
  },
  all: async () => {
    const home = freshHome('all')
    run('moqi install', moqi, ['install'], home)
    for (const name of plugins) addPlugin(home, 'tui', name)
    run('dsh --dump-config', dsh, ['--profile', 'tui', '--dump-config'], home)
    noStaleCopies(home, 'tui')
    // The same plugins without moqi's app, booted headless, so a plugin that
    // fails to activate shows on every system, not only where a pty exists.
    for (const name of plugins) addPlugin(home, 'plugins', name)
    await boot('boot plugins', 'plugins', home)
    noStaleCopies(home, 'plugins')
    if (process.platform === 'linux') await bootInTerminal('boot moqi + plugins (pty)', home)
  },
}
for (const name of plugins) {
  checks[name] = async () => {
    const home = freshHome(name)
    addPlugin(home, 'p', name)
    run('dsh --dump-config', dsh, ['--profile', 'p', '--dump-config'], home)
    await boot('boot', 'p', home)
    noStaleCopies(home, 'p')
  }
}

const results = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : []
let failures = 0
for (const [target, check] of Object.entries(checks)) {
  try {
    await check()
    results.push({ version, os, source, target, ok: true })
    console.log(`ok    ${target} (${source})`)
  } catch (error) {
    failures += 1
    const step = error instanceof StepFailure ? error.step : 'check crashed'
    const detail = error instanceof StepFailure ? error.detail : String(error)
    results.push({ version, os, source, target, ok: false, step, detail })
    console.log(`FAIL  ${target} (${source}) at ${step}\n${detail}`)
  }
}
writeFileSync(out, JSON.stringify(results, null, 2))
console.log(`${String(failures)} of ${String(Object.keys(checks).length)} targets failed (${source}, dsh ${version}, ${os})`)
