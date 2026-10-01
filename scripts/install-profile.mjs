/**
 * Create (or refresh) the `tui` profile in the Harness home and point it at
 * this checkout.
 *
 * A profile is a directory under `$DSH_HOME/profiles` holding a `package.json`
 * whose `dsh.profile.bundles` lists the patch layers to compose, its own
 * `cordis.patch.yml`, and a `pnpm-workspace.yaml`. This writes all three with
 * an absolute link to wherever this repository actually lives, which is why it
 * is a script rather than a `cp` of a template with a relative path in it.
 *
 * Run with: node scripts/install-profile.mjs [profileName]
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { findDshRoot, linkHarnessPackages } from './harness-root.mjs'

const requestedProfile = process.argv[2] ?? 'tui'
// A profile name becomes a directory under the profiles root, so it must be a
// flat, dotless token: the allowlist is what keeps `..` and separators out.
if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(requestedProfile)) {
  console.error(`install-profile: invalid profile name ${JSON.stringify(requestedProfile)}`)
  process.exit(1)
}
// `basename` is a no-op after the allowlist, and it is the path sanitiser the
// taint analysis recognises, so every downstream path is provably scoped.
const profileName = basename(requestedProfile)

const repoRoot = resolve(import.meta.dirname, '..')
const packageName = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).name

// The Harness home: $DSH_HOME when set and non-blank, else ~/.dsh.
const fromEnvironment = process.env.DSH_HOME
const dshHome =
  fromEnvironment !== undefined && fromEnvironment.trim() !== ''
    ? resolve(fromEnvironment)
    : join(homedir(), '.dsh')

// Resolve inside the profiles root and prove the result never leaves it, so no
// profile name can traverse out of the directory it is scoped to.
const profilesRoot = resolve(dshHome, 'profiles')
const profileDir = resolve(profilesRoot, profileName)
if (!profileDir.startsWith(profilesRoot + sep)) {
  console.error(`install-profile: invalid profile name ${JSON.stringify(profileName)}`)
  process.exit(1)
}
mkdirSync(profileDir, { recursive: true })

// The bundle needs its build output: the manifest's `main` points into lib/.
if (!existsSync(join(repoRoot, 'lib', 'index.js'))) {
  console.error('install-profile: lib/ is missing — run `npm run build` (or `pnpm run build`) first.')
  process.exit(1)
}

const manifestPath = join(profileDir, 'package.json')
const manifest = {
  name: `dsh-profile-${profileName}`,
  private: true,
  dependencies: {
    // Absolute, so the profile keeps resolving wherever the Harness home is.
    [packageName]: `link:${repoRoot}`,
  },
  dsh: {
    profile: {
      bundles: ['@deepseek-ai/dsh-base', packageName],
      // This bundle disables HMR: a reload repainting under the alternate
      // screen would corrupt it, so patches apply on restart.
      patchReload: 'startup',
    },
  },
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)

const workspacePath = join(profileDir, 'pnpm-workspace.yaml')
if (!existsSync(workspacePath)) {
  writeFileSync(workspacePath, 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
}

const patchPath = join(profileDir, 'cordis.patch.yml')
if (!existsSync(patchPath)) {
  // The loader requires a top-level YAML array, so a file of nothing but
  // comments is a parse error rather than "no patches" — the empty list has to
  // be written out explicitly.
  writeFileSync(
    patchPath,
    [
      '# Your own patch layer for this profile. It composes last, so anything',
      '# set here wins over the bundle patches. Replace [] with entries, e.g.',
      '#',
      '# - id: tui-app',
      '#   config:',
      '#     contextLimit: 131072',
      '#     thinking: true',
      '[]',
      '',
    ].join('\n'),
  )
}

console.log(`install-profile: wrote ${profileDir}`)

// pnpm is what the Harness itself uses for profiles; npm also works.
const manager = hasCommand('pnpm') ? 'pnpm' : 'npm'
try {
  execFileSync(manager, ['install'], { cwd: profileDir, stdio: 'inherit' })
} catch (error) {
  console.error(`install-profile: ${manager} install failed: ${error.message}`)
  console.error(`install-profile: run it yourself in ${profileDir}`)
  process.exit(1)
}

// The profile links this package from wherever it lives, so Node resolves its
// `@deepseek-ai/*` imports from the package's own directory — where, on a
// clean machine, those packages do not exist. Linking the harness's own copies
// in is what makes a freshly installed app boot at all; it is idempotent, and
// it deliberately keeps the harness's copies rather than installing a second
// `@deepseek-ai/cordis`, which would be a different Service class.
const dshRoot = findDshRoot()
if (dshRoot === undefined) {
  console.warn('install-profile: no `dsh` installation found to link harness packages from.')
  console.warn('install-profile: install @deepseek-ai/dsh, or set DSH_INSTALL_ROOT to its package directory.')
} else {
  const { linked, failed } = linkHarnessPackages(repoRoot, dshRoot)
  if (linked.length > 0) {
    console.log(`install-profile: linked ${String(linked.length)} harness packages into the app`)
  }
  if (failed.length > 0) {
    console.warn(`install-profile: could not link ${failed.join(', ')} — the app may fail to boot`)
    console.warn(`install-profile: re-run with permission to write ${repoRoot}/node_modules`)
  }
}

console.log(`install-profile: done — run it with:  dsh --profile ${profileName}`)

/** Whether a command exists on PATH. */
function hasCommand(name) {
  try {
    execFileSync('/bin/sh', ['-c', `command -v ${name}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
