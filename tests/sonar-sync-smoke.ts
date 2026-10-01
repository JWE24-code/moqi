/**
 * Smoke tests for the Sonar → GitHub issue sync: a fake `fetch` stands in for
 * both APIs so de-duplication, creation, and closing are pinned without a
 * network or a token.
 */
import assert from 'node:assert/strict'
import {
  fetchSonarIssues,
  issueBody,
  issueTitle,
  labelsFor,
  listTrackedIssues,
  sonarHeaders,
  sonarKeyFromBody,
  sync,
} from '../scripts/sync-sonar-issues.ts'
import type {
  FetchLike,
  FetchResponse,
  GitHubIssue,
  SonarIssue,
  SyncConfig,
} from '../scripts/sync-sonar-issues.ts'

let checks = 0
function check(label: string, condition: boolean): void {
  assert.ok(condition, label)
  checks += 1
}

const trackedIssue: SonarIssue = {
  key: 'AY-tracked',
  rule: 'typescript:S1234',
  severity: 'MAJOR',
  type: 'CODE_SMELL',
  component: 'JWE24-code_moqi:src/index.ts',
  line: 42,
  message: 'The tracked smell',
}
const newIssue: SonarIssue = {
  key: 'AY-new',
  rule: 'typescript:S4321',
  severity: 'CRITICAL',
  type: 'BUG',
  component: 'JWE24-code_moqi:src/tui.ts',
  line: 7,
  message: 'The new bug',
}

interface Call {
  method: string
  path: string
  body?: string
}

interface FakeState {
  sonar: SonarIssue[][]
  tracked: GitHubIssue[]
}

function makeResponse(status: number, payload: unknown): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }
}

function makeFetch(state: FakeState): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  let nextNumber = 100
  const fetchImpl: FetchLike = async (url, init) => {
    const parsed = new URL(url)
    const method = init?.method ?? 'GET'
    calls.push({ method, path: `${parsed.pathname}${parsed.search}`, body: init?.body })
    if (parsed.pathname.endsWith('/api/issues/search')) {
      const page = Number(parsed.searchParams.get('p')) - 1
      return makeResponse(200, { total: state.sonar.flat().length, issues: state.sonar[page] ?? [] })
    }
    if (parsed.pathname.endsWith('/labels') && method === 'POST') {
      return makeResponse(201, { name: 'sonar' })
    }
    if (parsed.pathname.endsWith('/issues') && method === 'POST') {
      nextNumber += 1
      return makeResponse(201, { number: nextNumber })
    }
    if (parsed.pathname.endsWith('/issues') && method === 'GET') {
      return makeResponse(200, state.tracked)
    }
    if (/\/issues\/\d+$/.test(parsed.pathname) && method === 'PATCH') {
      return makeResponse(200, { state: 'closed' })
    }
    return makeResponse(404, { message: `unexpected ${method} ${parsed.pathname}` })
  }
  return { fetchImpl, calls }
}

const baseConfig: SyncConfig = {
  host: 'https://sonarcloud.io',
  projectKey: 'JWE24-code_moqi',
  api: 'https://api.github.com',
  repo: 'JWE24-code/moqi',
  githubToken: 'github-token',
  label: 'sonar',
  dryRun: false,
  closeResolved: true,
}

// Pure formatting and marker handling.
check('a marker names its Sonar key', sonarKeyFromBody('before\n<!-- sonar-key:AY-123 -->\nafter') === 'AY-123')
check('a body without a marker names nothing', sonarKeyFromBody('plain body') === null)
check('a null body names nothing', sonarKeyFromBody(null) === null)
check('a long message is truncated under GitHub’s title limit', issueTitle({ ...newIssue, message: 'x'.repeat(400) }).length <= 250)
check('a short message keeps its title', issueTitle(newIssue) === '[Sonar] The new bug')
check('the body carries the marker', issueBody(newIssue, baseConfig.host, baseConfig.projectKey).includes('<!-- sonar-key:AY-new -->'))
check('the body carries the severity and rule', issueBody(newIssue, baseConfig.host, baseConfig.projectKey).includes('CRITICAL'))
check('the body links back to Sonar', issueBody(newIssue, baseConfig.host, baseConfig.projectKey).includes('sonarcloud.io/project/issues'))
check('labels pair the base and the severity', labelsFor(newIssue, 'sonar').join(',') === 'sonar,sonar:critical')
check('Sonar Cloud uses a bearer token', sonarHeaders('https://sonarcloud.io', 'tok').Authorization === 'Bearer tok')
check('a self-hosted server uses basic auth', sonarHeaders('https://sonar.example.com', 'tok').Authorization !== undefined)
check('no token sends no authorization', sonarHeaders('https://sonarcloud.io', undefined).Authorization === undefined)

// Two pages are followed until the reported total is reached.
{
  const { fetchImpl } = makeFetch({ sonar: [[trackedIssue], [newIssue]], tracked: [] })
  const issues = await fetchSonarIssues({ host: baseConfig.host, projectKey: baseConfig.projectKey }, fetchImpl)
  check('pagination gathers every page', issues.length === 2)
}

// Existing markers are read back, and unmarked issues are ignored.
{
  const { fetchImpl } = makeFetch({
    sonar: [],
    tracked: [
      { number: 10, state: 'open', body: '<!-- sonar-key:AY-tracked -->' },
      { number: 11, state: 'open', body: 'a hand-written issue' },
    ],
  })
  const tracked = await listTrackedIssues(
    { api: baseConfig.api, repo: baseConfig.repo, token: baseConfig.githubToken, label: baseConfig.label },
    fetchImpl,
  )
  check('a marker is mapped to its GitHub issue', tracked.get('AY-tracked')?.number === 10)
  check('an unmarked issue is not tracked', tracked.size === 1)
}

// An open Sonar issue already tracked creates nothing and closes nothing.
{
  const { fetchImpl, calls } = makeFetch({
    sonar: [[trackedIssue, newIssue]],
    tracked: [{ number: 10, state: 'open', body: '<!-- sonar-key:AY-tracked -->' }],
  })
  const created: string[] = []
  const result = await sync(baseConfig, fetchImpl, (line) => created.push(line))
  check('only the untracked issue is created', result.created.length === 1)
  check('a still-open tracked issue is not closed', result.closed.length === 0)
  const posts = calls.filter((call) => call.method === 'POST' && call.path.includes('/issues'))
  check('exactly one GitHub issue is opened', posts.length === 1)
  check('the opened issue carries the new key', posts[0]?.body?.includes('sonar-key:AY-new') === true)
}

// A resolved Sonar issue closes its open GitHub issue.
{
  const { fetchImpl } = makeFetch({
    sonar: [[newIssue]],
    tracked: [{ number: 10, state: 'open', body: '<!-- sonar-key:AY-tracked -->' }],
  })
  const result = await sync(baseConfig, fetchImpl)
  check('a resolved Sonar issue closes its GitHub issue', result.closed.length === 1 && result.closed[0] === 10)
  check('the resolved issue is not re-created', result.created.length === 1)
}

// A GitHub issue that is already closed is left alone even if Sonar is unresolved.
{
  const { fetchImpl } = makeFetch({
    sonar: [[trackedIssue]],
    tracked: [{ number: 10, state: 'closed', body: '<!-- sonar-key:AY-tracked -->' }],
  })
  const result = await sync(baseConfig, fetchImpl)
  check('an already-closed GitHub issue is not touched', result.closed.length === 0)
}

// Dry runs read both APIs but never write.
{
  const { fetchImpl, calls } = makeFetch({
    sonar: [[newIssue]],
    tracked: [{ number: 10, state: 'open', body: '<!-- sonar-key:AY-tracked -->' }],
  })
  const lines: string[] = []
  const result = await sync({ ...baseConfig, dryRun: true }, fetchImpl, (line) => lines.push(line))
  check('a dry run creates nothing', result.created.length === 0)
  check('a dry run closes nothing', result.closed.length === 0)
  check('a dry run reports what it would do', lines.some((line) => line.startsWith('would create')) && lines.some((line) => line.startsWith('would close')))
  check('a dry run writes nothing', calls.every((call) => call.method === 'GET'))
}

console.log(`ok - ${String(checks)} sonar-sync checks passed`)
