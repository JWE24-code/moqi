/**
 * Open a GitHub issue for every unresolved issue SonarQube reports.
 *
 * SonarQube's GitHub integration decorates pull requests and, on the
 * Enterprise plan, publishes security findings as code-scanning alerts; it
 * deliberately does not open GitHub issues. This script does that one job: it
 * reads every unresolved issue from a project's Sonar API and opens a GitHub
 * issue for each one whose Sonar key is not already tracked.
 *
 * De-duplication is a marker in the issue body, `<!-- sonar-key:... -->`, so
 * re-runs are idempotent. A second pass closes the GitHub issue whose Sonar
 * issue has since been resolved, unless `SONAR_SYNC_CLOSE_RESOLVED=0`.
 *
 * Configuration is environment only, so the same file runs from the
 * `sonar-issues` workflow and from a shell:
 *
 *   SONAR_HOST_URL          https://sonarcloud.io, or the server's base URL
 *   SONAR_PROJECT_KEY       the project key Sonar analyses
 *   SONAR_TOKEN             optional: only needed when the project is private
 *   GITHUB_REPOSITORY       owner/repo (provided by Actions)
 *   GITHUB_TOKEN            issues:write token (provided by Actions)
 *   SONAR_SYNC_LABEL        label for synced issues, default `sonar`
 *   SONAR_SYNC_DRY_RUN      `1` reports the plan and writes nothing
 *   SONAR_SYNC_CLOSE_RESOLVED  `0` leaves resolved Sonar issues open on GitHub
 *   SONAR_SYNC_TYPES        comma-separated Sonar types to sync, e.g. BUG,VULNERABILITY
 *   SONAR_SYNC_SEVERITIES   comma-separated Sonar severities, e.g. BLOCKER,CRITICAL
 *
 * Run with: node --experimental-strip-types scripts/sync-sonar-issues.ts
 */

import { pathToFileURL } from 'node:url'

/** The Sonar fields the sync reports. */
export interface SonarIssue {
  key: string
  rule: string
  severity: string
  type: string
  component: string
  line?: number
  message: string
}

/** The GitHub fields the sync de-duplicates and closes on. */
export interface GitHubIssue {
  number: number
  state: string
  body: string | null
}

/** The slice of `fetch` the script uses, so tests can supply their own. */
export interface FetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
}

export interface FetchResponse {
  ok: boolean
  status: number
  statusText: string
  json(): Promise<unknown>
  text(): Promise<string>
}

export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponse>

export interface SyncConfig {
  host: string
  projectKey: string
  token?: string
  api: string
  repo: string
  githubToken: string
  label: string
  dryRun: boolean
  closeResolved: boolean
  types?: string
  severities?: string
}

export interface SyncResult {
  open: number
  created: number[]
  closed: number[]
}

/** The marker a tracked GitHub issue carries, and the Sonar key it names. */
const MARKER = /<!--\s*sonar-key:(\S+)\s*-->/

export function sonarKeyFromBody(body: string | null | undefined): string | null {
  const match = body == null ? null : MARKER.exec(body)
  return match?.[1] ?? null
}

/** Sonar's message is the title, held under GitHub's 256-character limit. */
export function issueTitle(issue: SonarIssue): string {
  const title = `[Sonar] ${issue.message}`
  return title.length <= 250 ? title : `${title.slice(0, 247)}...`
}

export function issueBody(issue: SonarIssue, host: string, projectKey: string): string {
  const file = issue.component.split(':').pop() ?? issue.component
  const location = issue.line === undefined ? file : `${file}:${issue.line}`
  return [
    `<!-- sonar-key:${issue.key} -->`,
    `**${issue.type}** · **${issue.severity}** · \`${issue.rule}\``,
    `\`${location}\``,
    '',
    `${host}/project/issues?id=${encodeURIComponent(projectKey)}&open=${issue.key}`,
  ].join('\n')
}

export function labelsFor(issue: SonarIssue, label: string): string[] {
  return [label, `${label}:${issue.severity.toLowerCase()}`]
}

/** Sonar Cloud takes a bearer token; a self-hosted server takes it as basic auth. */
export function sonarHeaders(host: string, token: string | undefined): Record<string, string> {
  if (token === undefined || token === '') return { Accept: 'application/json' }
  const basic = Buffer.from(`${token}:`).toString('base64')
  const authorization = host.includes('sonarcloud.io') ? `Bearer ${token}` : `Basic ${basic}`
  return { Accept: 'application/json', Authorization: authorization }
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

/** Every unresolved issue on the project, paged through the Sonar API. */
/** The host without its trailing slashes, so joins never double one. */
function stripTrailingSlashes(host: string): string {
  let end = host.length
  while (end > 0 && host[end - 1] === '/') end -= 1
  return host.slice(0, end)
}

export async function fetchSonarIssues(
  options: { host: string; projectKey: string; token?: string; types?: string; severities?: string },
  fetchImpl: FetchLike = fetch,
): Promise<SonarIssue[]> {
  const base = stripTrailingSlashes(options.host)
  const headers = sonarHeaders(base, options.token)
  const issues: SonarIssue[] = []
  for (let page = 1; ; page += 1) {
    const url = new URL(`${base}/api/issues/search`)
    url.searchParams.set('componentKeys', options.projectKey)
    url.searchParams.set('resolved', 'false')
    if (options.types !== undefined && options.types !== '') url.searchParams.set('types', options.types)
    if (options.severities !== undefined && options.severities !== '') {
      url.searchParams.set('severities', options.severities)
    }
    url.searchParams.set('ps', '100')
    url.searchParams.set('p', String(page))
    const response = await fetchImpl(url.toString(), { headers })
    if (!response.ok) {
      throw new Error(`Sonar ${response.status} ${response.statusText}: ${await response.text()}`)
    }
    const body = (await response.json()) as { total?: number; issues?: SonarIssue[] }
    const batch = body.issues ?? []
    issues.push(...batch)
    if (batch.length === 0 || issues.length >= (body.total ?? issues.length)) return issues
    if (page >= 1000) throw new Error('Sonar issue pagination did not terminate')
  }
}

/** GitHub issues already carrying a marker, keyed by the Sonar key they name. */
export async function listTrackedIssues(
  options: { api: string; repo: string; token: string; label: string },
  fetchImpl: FetchLike = fetch,
): Promise<Map<string, GitHubIssue>> {
  const tracked = new Map<string, GitHubIssue>()
  for (let page = 1; ; page += 1) {
    const url = new URL(`${options.api}/repos/${options.repo}/issues`)
    url.searchParams.set('state', 'all')
    url.searchParams.set('labels', options.label)
    url.searchParams.set('per_page', '100')
    url.searchParams.set('page', String(page))
    const response = await fetchImpl(url.toString(), { headers: githubHeaders(options.token) })
    if (!response.ok) {
      throw new Error(`GitHub ${response.status} ${response.statusText}: ${await response.text()}`)
    }
    const body = (await response.json()) as GitHubIssue[]
    for (const item of body) {
      const key = sonarKeyFromBody(item.body)
      if (key !== null) tracked.set(key, item)
    }
    if (body.length < 100) return tracked
    if (page >= 1000) throw new Error('GitHub issue pagination did not terminate')
  }
}

/**
 * Create a label. A duplicate is a 422, which is the happy path on every run
 * after the first, so it is swallowed rather than treated as a failure.
 */
async function ensureLabel(
  name: string,
  options: { api: string; repo: string; token: string },
  fetchImpl: FetchLike,
): Promise<void> {
  const response = await fetchImpl(`${options.api}/repos/${options.repo}/labels`, {
    method: 'POST',
    headers: { ...githubHeaders(options.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, color: '8250df', description: 'Tracked from SonarQube' }),
  })
  if (!response.ok && response.status !== 422) {
    throw new Error(`GitHub label ${name}: ${response.status} ${await response.text()}`)
  }
}

async function createIssue(
  issue: SonarIssue,
  options: {
    api: string
    repo: string
    token: string
    host: string
    projectKey: string
    label: string
  },
  fetchImpl: FetchLike,
): Promise<number> {
  const response = await fetchImpl(`${options.api}/repos/${options.repo}/issues`, {
    method: 'POST',
    headers: { ...githubHeaders(options.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: issueTitle(issue),
      body: issueBody(issue, options.host, options.projectKey),
      labels: labelsFor(issue, options.label),
    }),
  })
  if (!response.ok) {
    throw new Error(`GitHub issue for ${issue.key}: ${response.status} ${await response.text()}`)
  }
  const created = (await response.json()) as { number: number }
  return created.number
}

async function closeIssue(
  item: GitHubIssue,
  options: { api: string; repo: string; token: string },
  fetchImpl: FetchLike,
): Promise<void> {
  const response = await fetchImpl(`${options.api}/repos/${options.repo}/issues/${String(item.number)}`, {
    method: 'PATCH',
    headers: { ...githubHeaders(options.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
  })
  if (!response.ok) {
    throw new Error(`GitHub issue #${String(item.number)}: ${response.status} ${await response.text()}`)
  }
}

/** Reconcile GitHub with Sonar once; returns what it created and closed. */
export async function sync(
  config: SyncConfig,
  fetchImpl: FetchLike = fetch,
  report: (line: string) => void = () => {},
): Promise<SyncResult> {
  const issues = await fetchSonarIssues(
    {
      host: config.host,
      projectKey: config.projectKey,
      token: config.token,
      types: config.types,
      severities: config.severities,
    },
    fetchImpl,
  )
  const tracked = await listTrackedIssues(
    { api: config.api, repo: config.repo, token: config.githubToken, label: config.label },
    fetchImpl,
  )
  const created = await openIssuesFor(issues, tracked, config, fetchImpl, report)
  const closed = config.closeResolved
    ? await closeResolved(issues, tracked, config, fetchImpl, report)
    : []
  return { open: issues.length, created, closed }
}

/** Open a GitHub issue for every Sonar issue nothing tracks yet. */
async function openIssuesFor(
  issues: SonarIssue[],
  tracked: Map<string, GitHubIssue>,
  config: SyncConfig,
  fetchImpl: FetchLike,
  report: (line: string) => void,
): Promise<number[]> {
  const ensured = new Set<string>()
  const created: number[] = []
  // Sequential on purpose — GitHub assigns numbers in call order — so the
  // loop is a promise chain rather than an awaited `for`.
  await issues.reduce(async (walked, issue) => {
    await walked
    if (tracked.has(issue.key) || config.dryRun) {
      if (config.dryRun) report(`would create: ${issue.key} — ${issueTitle(issue)}`)
      return
    }
    for (const label of labelsFor(issue, config.label)) {
      if (ensured.has(label)) continue
      await ensureLabel(label, { api: config.api, repo: config.repo, token: config.githubToken }, fetchImpl)
      ensured.add(label)
    }
    const number = await createIssue(
      issue,
      {
        api: config.api,
        repo: config.repo,
        token: config.githubToken,
        host: config.host,
        projectKey: config.projectKey,
        label: config.label,
      },
      fetchImpl,
    )
    created.push(number)
    report(`created #${String(number)} for ${issue.key}`)
  }, Promise.resolve())
  return created
}

/** Close the tracked issues whose Sonar finding is resolved. */
async function closeResolved(
  issues: SonarIssue[],
  tracked: Map<string, GitHubIssue>,
  config: SyncConfig,
  fetchImpl: FetchLike,
  report: (line: string) => void,
): Promise<number[]> {
  const openKeys = new Set(issues.map((issue) => issue.key))
  const closed: number[] = []
  await [...tracked].reduce(async (walked, [key, item]) => {
    await walked
    if (openKeys.has(key) || item.state === 'closed') return
    if (config.dryRun) {
      report(`would close #${String(item.number)} (${key} is resolved)`)
      return
    }
    await closeIssue(item, { api: config.api, repo: config.repo, token: config.githubToken }, fetchImpl)
    closed.push(item.number)
    report(`closed #${String(item.number)} (${key} was resolved)`)
  }, Promise.resolve())
  return closed
}

async function main(): Promise<void> {
  const host = process.env.SONAR_HOST_URL ?? ''
  const projectKey = process.env.SONAR_PROJECT_KEY ?? ''
  const repo = process.env.GITHUB_REPOSITORY ?? ''
  const githubToken = process.env.GITHUB_TOKEN ?? ''
  const missing = [
    ['SONAR_HOST_URL', host],
    ['SONAR_PROJECT_KEY', projectKey],
    ['GITHUB_REPOSITORY', repo],
    ['GITHUB_TOKEN', githubToken],
  ]
    .filter(([, value]) => value === '')
    .map(([name]) => name)
  if (missing.length > 0) throw new Error(`missing environment: ${missing.join(', ')}`)

  const dryRun = process.env.SONAR_SYNC_DRY_RUN === '1'
  const result = await sync(
    {
      host,
      projectKey,
      token: process.env.SONAR_TOKEN,
      api: process.env.GITHUB_API_URL ?? 'https://api.github.com',
      repo,
      githubToken,
      label: process.env.SONAR_SYNC_LABEL ?? 'sonar',
      dryRun,
      closeResolved: process.env.SONAR_SYNC_CLOSE_RESOLVED !== '0',
      types: process.env.SONAR_SYNC_TYPES,
      severities: process.env.SONAR_SYNC_SEVERITIES,
    },
    fetch,
    (line) => { console.log(`sonar-issues: ${line}`) },
  )
  console.log(
    `sonar-issues: ${String(result.open)} open in Sonar, ` +
      `${String(result.created.length)} created, ${String(result.closed.length)} closed` +
      `${dryRun ? ' (dry run)' : ''}`,
  )
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  try {
    await main()
  } catch (error: unknown) {
    console.error(`sonar-issues: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
