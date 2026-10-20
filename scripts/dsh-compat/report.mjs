#!/usr/bin/env node
/**
 * Report step of the dsh compatibility watch: merge every job's results into
 * the tracking issue (creating it on first use), and open, update or close
 * one failure issue per target and source.
 *
 * Environment: DSH_COMPAT_RESULTS_DIR (the downloaded artifacts, default
 * `results`), GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID, GH_TOKEN,
 * DSH_COMPAT_MATRIX (the plan's matrix, for the tags each version had).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { which } from '../harness-root.mjs'
import {
  FAILURE_LABEL,
  TRACKING_LABEL,
  TRACKING_TITLE,
  failureActions,
  failureMatches,
  failureTitle,
  parseState,
  recordResults,
  renderBody,
} from './state.mjs'

const repo = process.env.GITHUB_REPOSITORY
const repoUrl = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}`
const runId = process.env.GITHUB_RUN_ID
const runUrl = `${repoUrl}/actions/runs/${runId}`
const scratch = mkdtempSync(join(tmpdir(), 'dsh-compat-'))

// gh by absolute path, so nothing earlier on PATH can stand in for it.
const ghPath = which('gh')
if (ghPath === undefined) {
  console.error('report: no gh on PATH')
  process.exit(2)
}
const gh = (args) => execFileSync(ghPath, args, { encoding: 'utf8' })

/** Pass long text through a file, so no body ever lands on a command line. */
function bodyFile(name, text) {
  const file = join(scratch, name)
  writeFileSync(file, text)
  return file
}

/** Every results JSON under the downloaded-artifacts directory. */
function collect(dir) {
  const results = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) results.push(...collect(path))
    else if (name.endsWith('.json')) results.push(...JSON.parse(readFileSync(path, 'utf8')))
  }
  return results
}

function ensureLabel(name, color, description) {
  try {
    gh(['label', 'create', name, '--repo', repo, '--color', color, '--description', description])
  } catch {
    // Already exists.
  }
}

const results = collect(process.env.DSH_COMPAT_RESULTS_DIR ?? 'results')
if (results.length === 0) {
  console.error('report: no results found — every check job failed before writing any')
  process.exit(1)
}

const tagsByVersion = {}
for (const job of JSON.parse(process.env.DSH_COMPAT_MATRIX ?? '{"include":[]}').include) {
  tagsByVersion[job.version] = job.tags
}

ensureLabel(TRACKING_LABEL, '0e8a16', 'dsh compatibility watch')
ensureLabel(FAILURE_LABEL, 'd93f0b', 'A dsh release breaks a watched package')

// Tracking issue: create on first use, then rewrite its body each run.
const tracking = JSON.parse(gh(['issue', 'list', '--repo', repo, '--label', TRACKING_LABEL, '--state', 'open', '--json', 'number,body', '--limit', '1']))
const state = recordResults(parseState(tracking[0]?.body), results, { run: runId, at: new Date().toISOString(), tagsByVersion })
const body = bodyFile('tracking.md', renderBody(state, repoUrl))
if (tracking.length === 0) {
  gh(['issue', 'create', '--repo', repo, '--title', TRACKING_TITLE, '--label', TRACKING_LABEL, '--body-file', body])
} else {
  gh(['issue', 'edit', String(tracking[0].number), '--repo', repo, '--body-file', body])
}

// Failure issues: one open issue per target and source, whatever the version.
const open = JSON.parse(gh(['issue', 'list', '--repo', repo, '--label', FAILURE_LABEL, '--state', 'open', '--json', 'number,title', '--limit', '100']))
for (const action of failureActions(results)) {
  const existing = open.find((issue) => failureMatches(issue.title, action.target, action.source))
  if (action.kind === 'close') {
    if (existing === undefined) continue
    const note = `Passes on dsh ${action.version} on every system tested ([run](${runUrl})).`
    gh(['issue', 'close', String(existing.number), '--repo', repo, '--comment', note])
    console.log(`closed #${existing.number}`)
    continue
  }
  const report = [
    `dsh **${action.version}** breaks **${action.target}** (${action.source}) — [run](${runUrl}).`,
    '',
    ...action.failed.flatMap((r) => [`**${r.os}**, at \`${r.step}\`:`, '', '```', r.detail ?? '', '```', '']),
  ].join('\n')
  const file = bodyFile(`fail-${action.target}-${action.source}.md`, report)
  if (existing === undefined) {
    gh(['issue', 'create', '--repo', repo, '--title', failureTitle(action.version, action.target, action.source), '--label', FAILURE_LABEL, '--body-file', file])
    console.log(`opened: ${failureTitle(action.version, action.target, action.source)}`)
  } else {
    gh(['issue', 'comment', String(existing.number), '--repo', repo, '--body-file', file])
    console.log(`commented on #${existing.number}`)
  }
}

const failed = results.filter((r) => !r.ok).length
console.log(`${String(results.length - failed)} passed, ${String(failed)} failed`)
// A red run is what makes GitHub notify; the issues carry the detail.
if (failed > 0) process.exitCode = 1
