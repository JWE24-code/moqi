/**
 * Fail if any `@deepseek-ai/*` package is a runtime dependency.
 *
 * The Harness packages must stay optional peers. A plugin that lists one under
 * `dependencies` installs its own copy into the profile, which shadows the
 * harness's in-box copy: startup then dies with "required plugin did not
 * activate" or `reading 'prepare'` (deepseek-harness discussions #10364 and
 * #10338). This guard keeps the manifest out of that shape.
 *
 * Run with: node scripts/check-harness-deps.mjs
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** The `@deepseek-ai/*` names in a manifest's `dependencies`. */
export function harnessDependencies(manifest) {
  const dependencies = manifest?.dependencies
  if (dependencies === null || typeof dependencies !== 'object') return []
  return Object.keys(dependencies).filter((name) => name.startsWith('@deepseek-ai/'))
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  const manifestPath = resolve(import.meta.dirname, '..', 'package.json')
  const offending = harnessDependencies(JSON.parse(readFileSync(manifestPath, 'utf8')))
  if (offending.length > 0) {
    console.error(`check-harness-deps: ${manifestPath} lists Harness packages under dependencies:`)
    for (const name of offending) console.error(`  ${name}`)
    console.error('check-harness-deps: move them to peerDependencies, marked optional in peerDependenciesMeta.')
    process.exit(1)
  }
  console.log(`check-harness-deps: ok — no @deepseek-ai/* runtime dependencies in ${manifestPath}`)
}
