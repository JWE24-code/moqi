/**
 * `/jobs` formatting: a background job list rendered as markdown.
 *
 * Pure, like the rest of `tui/`: the app layer hands over snapshots and owns
 * the registry calls.
 * @module
 */

/** The subset of a job snapshot this module formats. */
export interface JobLike {
  id: string
  kind: string
  label: string
  // Free-form string: the registry may report statuses this build never named.
  status: string
  detail?: string
  startedAt: number
  finishedAt?: number
}

/** A compact "3s" / "4m" / "2h" duration. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${String(Math.max(Math.floor(seconds), 0))}s`
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m`
  if (seconds < 86400) return `${String(Math.floor(seconds / 3600))}h`
  return `${String(Math.floor(seconds / 86400))}d`
}

/** The mark a job's state earns in the list. */
export function jobMark(status: string): string {
  if (status === 'running') return '⠹'
  if (status === 'stopping') return '⠴'
  if (status === 'completed') return '✓'
  if (status === 'killed') return '·'
  return '✗'
}

/**
 * The `/jobs` overlay body.
 *
 * Running jobs first, then the settled ones newest-first, because the list
 * exists to answer "what is still going" before "what happened".
 */
export function renderJobs(jobs: readonly JobLike[], now = Date.now()): string {
  if (jobs.length === 0) {
    return ['**Background jobs**', '', 'Nothing has run in the background in this session.'].join('\n')
  }
  const running = jobs.filter((job) => job.status === 'running' || job.status === 'stopping')
  const settled = jobs
    .filter((job) => job.status !== 'running' && job.status !== 'stopping')
    .sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt))
  const lines: string[] = ['**Background jobs**', '']
  const row = (job: JobLike): string => {
    const end = job.finishedAt ?? now
    const duration = formatDuration((end - job.startedAt) / 1000)
    const detail = job.detail === undefined || job.detail === '' ? '' : ` — ${job.detail}`
    return `- ${jobMark(job.status)} \`${job.id}\` ${job.kind}: ${job.label}${detail} · ${job.status} ${duration}`
  }
  if (running.length > 0) {
    lines.push(`Running (${String(running.length)})`, '')
    for (const job of running) lines.push(row(job))
    lines.push('')
  }
  if (settled.length > 0) {
    lines.push(`Finished (${String(settled.length)})`, '')
    for (const job of settled) lines.push(row(job))
    lines.push('')
  }
  lines.push('`/jobs kill <id>` stops one · esc closes')
  return lines.join('\n')
}
