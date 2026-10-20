/**
 * The pure half of the dsh compatibility watch: which dsh versions still need
 * testing, the job matrix for them, and how results become the tracking
 * issue's table and the per-target failure issues.
 *
 * State lives in the tracking issue's body, as JSON inside an HTML comment, so
 * the watch needs no token beyond the workflow's own `issues: write` and keeps
 * no store anywhere else. Nothing here touches the network or the disk; the
 * plan, check and report scripts do the I/O.
 */

/** The packages under watch, plus `all` — moqi with every plugin in one profile. */
export const TARGETS = ['moqi-tui', 'dsh-jev-loop', 'dsh-pii-anonymizer', 'moqi-jev-loop', 'all']

/** Published = what `npm install` gives users today; main = what ships next. */
export const SOURCES = ['published', 'main']

export const TRACKING_LABEL = 'dsh-compat'
export const TRACKING_TITLE = 'dsh compatibility'
export const FAILURE_LABEL = 'dsh-compat-failure'

const STATE_OPEN = '<!-- dsh-compat-state '
const STATE_CLOSE = ' -->'

/** How many versions the table shows; older ones stay in the state only. */
const TABLE_ROWS = 15

/** Read the state out of a tracking issue body; an absent or broken one is empty. */
export function parseState(body) {
  const start = typeof body === 'string' ? body.indexOf(STATE_OPEN) : -1
  if (start === -1) return { versions: {} }
  const end = body.indexOf(STATE_CLOSE, start + STATE_OPEN.length)
  if (end === -1) return { versions: {} }
  try {
    const state = JSON.parse(body.slice(start + STATE_OPEN.length, end))
    return state !== null && typeof state.versions === 'object' ? state : { versions: {} }
  } catch {
    return { versions: {} }
  }
}

/**
 * The versions to test this run.
 *
 * @param {object} input
 * @param {Record<string, string>} input.distTags dsh's dist-tags, tag → version
 * @param {string[]} input.tags the tags under watch (e.g. latest, next)
 * @param {string[]} [input.versions] exact versions asked for by hand
 * @param {Record<string, unknown>} input.tested versions already in the state
 * @param {boolean} [input.force] test even what was tested before
 * @returns {{ version: string, tags: string[] }[]} one entry per version
 */
export function pickVersions({ distTags, tags, versions = [], tested, force = false }) {
  const byVersion = new Map()
  for (const tag of tags) {
    const version = distTags[tag]
    if (version === undefined) continue
    byVersion.set(version, [...(byVersion.get(version) ?? []), tag])
  }
  for (const version of versions) {
    if (!byVersion.has(version)) byVersion.set(version, [])
  }
  return [...byVersion]
    .filter(([version]) => force || !(version in tested))
    .map(([version, versionTags]) => ({ version, tags: versionTags }))
}

/**
 * One job per version and OS. macOS runs only for `latest`: it has never
 * differed from Linux here, and a prerelease is not what users install.
 */
export function buildMatrix(picked) {
  const include = []
  for (const { version, tags } of picked) {
    const systems = tags.includes('latest')
      ? ['ubuntu-latest', 'windows-latest', 'macos-latest']
      : ['ubuntu-latest', 'windows-latest']
    for (const os of systems) include.push({ version, tags: tags.join(',') || 'manual', os })
  }
  return { include }
}

/** Record one run's results under their versions. Returns the new state. */
export function recordResults(state, results, { run, at, tagsByVersion = {} }) {
  const versions = { ...state.versions }
  for (const result of results) {
    const entry = versions[result.version] ?? { tags: tagsByVersion[result.version] ?? '', results: [] }
    versions[result.version] = {
      ...entry,
      run,
      at,
      results: [
        ...entry.results.filter((r) => !sameCell(r, result)),
        { os: result.os, source: result.source, target: result.target, ok: result.ok },
      ],
    }
  }
  return { versions }
}

function sameCell(a, b) {
  return a.os === b.os && a.source === b.source && a.target === b.target
}

/** Newest first, by dotted numeric order with prereleases before their release. */
export function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre = ''] = v.split('-')
    return { nums: core.split('.').map(Number), pre }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < 3; i += 1) {
    if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (y.nums[i] ?? 0) - (x.nums[i] ?? 0)
  }
  if (x.pre === y.pre) return 0
  if (x.pre === '') return -1
  if (y.pre === '') return 1
  return y.pre.localeCompare(x.pre, 'en', { numeric: true })
}

/** One table cell: a tick, or a cross naming the systems that failed. */
function cell(results, source, target) {
  const rows = results.filter((r) => r.source === source && r.target === target)
  if (rows.length === 0) return '—'
  const failed = rows.filter((r) => !r.ok).map((r) => r.os.replace(/-latest$/, ''))
  return failed.length === 0 ? '✅' : `❌ ${failed.join(', ')}`
}

/** The tracking issue's whole body: explanation, table, then the state. */
export function renderBody(state, repoUrl) {
  const header = ['dsh', 'tags', ...SOURCES.flatMap((s) => TARGETS.map((t) => `${t} (${s})`)), 'run']
  const lines = [
    'Every few hours a workflow checks npm for new `@deepseek-ai/dsh` releases on the',
    'watched dist-tags, installs moqi and each plugin against them on Linux and Windows',
    '(and macOS for `latest`), and records the result here. **published** is what',
    '`npm install` gives users today; **main** is each repository\'s current `main`.',
    'A failure opens its own `dsh-compat-failure` issue, closed again by the first',
    'version that passes.',
    '',
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
  ]
  const versions = Object.keys(state.versions).sort(compareVersions).slice(0, TABLE_ROWS)
  for (const version of versions) {
    const entry = state.versions[version]
    const cells = SOURCES.flatMap((s) => TARGETS.map((t) => cell(entry.results, s, t)))
    const run = entry.run === undefined ? '' : `[run](${repoUrl}/actions/runs/${entry.run})`
    lines.push(`| ${version} | ${entry.tags || ''} | ${cells.join(' | ')} | ${run} |`)
  }
  lines.push('', `${STATE_OPEN}${JSON.stringify(state)}${STATE_CLOSE}`)
  return lines.join('\n')
}

export function failureTitle(version, target, source) {
  return `dsh ${version} breaks ${target} (${source})`
}

/** Whether an open failure issue's title is about this target and source. */
export function failureMatches(title, target, source) {
  return title.endsWith(` breaks ${target} (${source})`)
}

/**
 * What to do with failure issues after a run, per target and source:
 * `open` when any system failed, `close` when every system passed.
 */
export function failureActions(results) {
  const cells = new Map()
  for (const r of results) {
    const key = `${r.version}\u0000${r.target}\u0000${r.source}`
    const cellResults = cells.get(key) ?? []
    cellResults.push(r)
    cells.set(key, cellResults)
  }
  const actions = []
  for (const [key, rows] of cells) {
    const [version, target, source] = key.split('\u0000')
    const failed = rows.filter((r) => !r.ok)
    actions.push(
      failed.length > 0
        ? { kind: 'open', version, target, source, failed }
        : { kind: 'close', version, target, source },
    )
  }
  return actions
}
