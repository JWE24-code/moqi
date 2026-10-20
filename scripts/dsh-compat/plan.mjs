#!/usr/bin/env node
/**
 * Plan step of the dsh compatibility watch: read dsh's dist-tags and the
 * tracking issue, then emit the job matrix for every version not yet tested.
 *
 * Environment: DSH_COMPAT_TAGS (comma list, default latest,next),
 * DSH_COMPAT_VERSIONS (comma list of exact versions), DSH_COMPAT_FORCE (1 to
 * retest), GITHUB_REPOSITORY, GITHUB_OUTPUT, GH_TOKEN for `gh`.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { which } from '../harness-root.mjs'
import { buildMatrix, parseState, pickVersions, TRACKING_LABEL } from './state.mjs'

const list = (value) => (value ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '')

/** A command's absolute path, so nothing earlier on PATH can stand in for it. */
function resolve(name) {
  const path = which(name)
  if (path === undefined) throw new Error(`plan: no ${name} on PATH`)
  return path
}

const distTags = JSON.parse(execFileSync(resolve('npm'), ['view', '@deepseek-ai/dsh', 'dist-tags', '--json'], { encoding: 'utf8' }))
const issues = JSON.parse(
  execFileSync(
    resolve('gh'),
    ['issue', 'list', '--repo', process.env.GITHUB_REPOSITORY, '--label', TRACKING_LABEL, '--state', 'open', '--json', 'number,body', '--limit', '1'],
    { encoding: 'utf8' },
  ),
)
const state = parseState(issues[0]?.body)

const picked = pickVersions({
  distTags,
  tags: list(process.env.DSH_COMPAT_TAGS ?? 'latest,next'),
  versions: list(process.env.DSH_COMPAT_VERSIONS),
  tested: state.versions,
  force: process.env.DSH_COMPAT_FORCE === '1',
})
const matrix = buildMatrix(picked)

console.log(`dist-tags: ${JSON.stringify(distTags)}`)
console.log(picked.length === 0 ? 'nothing new to test' : `to test: ${picked.map((p) => p.version).join(', ')}`)

if (process.env.GITHUB_OUTPUT !== undefined) {
  appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\n`)
  appendFileSync(process.env.GITHUB_OUTPUT, `has-work=${picked.length > 0 ? 'true' : 'false'}\n`)
}
