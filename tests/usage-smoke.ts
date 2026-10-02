/**
 * Usage-ledger smoke: folding turns into per-provider totals, rolling
 * session/week windows, and DeepSeek's peak-hour schedule.
 */

import {
  CHART_WIDTH,
  SESSION_MS,
  WEEK_MS,
  bucketDelta,
  cacheHitRate,
  deepSeekPeakStatus,
  filledWidth,
  grandTotal,
  grouped,
  isEmptyBuckets,
  looksLikeDeepSeek,
  noBuckets,
  promptTotal,
  recordUsage,
  recordUsageEntry,
  sortedRows,
  totalUsage,
  windowUsage,
  type TokenBuckets,
  type UsageEntry,
  type UsageLedger,
} from '../src/usage.ts'

let passed = 0
let failed = 0
function pass(): void {
  passed += 1
}
function fail(name: string): void {
  failed += 1
  console.error(`FAIL: ${name}`)
}
function check(name: string, condition: boolean): void {
  const settle = condition ? pass : fail
  settle(name)
}

/** A bucket set, spelled positionally so a test row stays readable. */
function buckets(uncached: number, output: number, cacheRead = 0, cacheWrite = 0): TokenBuckets {
  return {
    uncachedInputTokens: uncached,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  }
}

// ------------------------------------------------------------ bucket algebra

check('an empty bucket set totals to nothing', isEmptyBuckets(noBuckets()))
check('promptTotal counts every prompt-side bucket', promptTotal(buckets(100, 7, 20, 5)) === 125)
check('grandTotal adds output to the prompt side', grandTotal(buckets(100, 7, 20, 5)) === 132)
check('cache hit rate is cache reads over all prompt tokens', cacheHitRate(buckets(75, 0, 25)) === 0.25)
check('cache hit rate of a route with no prompt tokens is undefined', cacheHitRate(noBuckets()) === undefined)

// The sound subtraction the ledger now rests on: two readings of one session's
// cumulative billed usage, whose difference is exactly what was billed between.
const growth = bucketDelta(buckets(100, 10, 5, 1), buckets(180, 25, 9, 1))
check('a delta between two cumulative readings is their difference', growth.uncachedInputTokens === 80)
check('every bucket is differenced independently', growth.outputTokens === 15 && growth.cacheReadTokens === 4)
check('a bucket that did not move contributes nothing', growth.cacheWriteTokens === 0)

// A projection replaying from zero (a version bump, a rewritten log) must not
// register as negative spend.
const backwards = bucketDelta(buckets(500, 100), buckets(10, 2))
check('a reading that moved backwards clamps to zero rather than going negative', isEmptyBuckets(backwards))

// ------------------------------------------------------------- recordUsage

let ledger: UsageLedger = {}
ledger = recordUsage(ledger, 'anthropic', buckets(1200, 300, 40, 10))
check('a fresh provider gets a row', ledger['anthropic']?.uncachedInputTokens === 1200)
check('output tokens land too', ledger['anthropic']?.outputTokens === 300)
check('cache buckets are kept separately, not folded into the prompt total', ledger['anthropic']?.cacheReadTokens === 40)
check('one turn is counted', ledger['anthropic']?.turns === 1)

ledger = recordUsage(ledger, 'anthropic', buckets(800, 150))
check('a second turn accumulates rather than overwrites', ledger['anthropic']?.uncachedInputTokens === 2000)
check('turns keeps counting', ledger['anthropic']?.turns === 2)
check('a bucket absent from the second turn keeps the first turn\'s figure', ledger['anthropic']?.cacheReadTokens === 40)

ledger = recordUsage(ledger, 'openai-codex', buckets(500, 100))
check('a second provider gets its own row', ledger['openai-codex']?.uncachedInputTokens === 500)
check('the first provider is untouched by the second', ledger['anthropic']?.uncachedInputTokens === 2000)

const before = ledger
const after = recordUsage(ledger, 'anthropic', noBuckets())
check('a turn with no measured usage records nothing', after === before)
check('and does not inflate the turn count', after['anthropic']?.turns === 2)

const unnamed = recordUsage({}, '', buckets(100, 50))
check(
  'an empty provider id files under "unknown" rather than vanishing',
  unnamed['unknown']?.uncachedInputTokens === 100,
)

// ---------------------------------------------------------------- totalUsage

const total = totalUsage(ledger)
check('total sums every provider\'s uncached input', total.uncachedInputTokens === 2500)
check('total sums every provider\'s output', total.outputTokens === 550)
check('total sums every provider\'s cache reads', total.cacheReadTokens === 40)
check('total sums every provider\'s turns', total.turns === 3)
check('an empty ledger totals to zero', grandTotal(totalUsage({})) === 0)

// ---------------------------------------------------------------- sortedRows

const rows = sortedRows(ledger)
check('rows are sorted busiest first', rows[0]?.[0] === 'anthropic' && rows[1]?.[0] === 'openai-codex')
check('an empty ledger sorts to nothing', sortedRows({}).length === 0)

// ------------------------------------------------------------------ grouped

check('grouped adds thousands separators', grouped(12345) === '12,345')
check('grouped leaves small numbers alone', grouped(70) === '70')

// --------------------------------------------------------------- filledWidth

check('a zero share fills nothing', filledWidth(0) === 0)
check('a full share fills every cell', filledWidth(1) === CHART_WIDTH)
check('a share above 1 is clamped to the chart width', filledWidth(1.5) === CHART_WIDTH)
check('a negative share is clamped to zero', filledWidth(-0.2) === 0)
check('a half share fills half the chart', filledWidth(0.5) === CHART_WIDTH / 2)
check('a share just shy of 100% still rounds up to a full bar', filledWidth(0.99) === CHART_WIDTH)

// ---------------------------------------------------------- rolling windows

const hour = 60 * 60 * 1000
const t0 = 1_700_000_000_000 // an arbitrary but fixed anchor

let entries: UsageEntry[] = []
entries = recordUsageEntry(entries, 'anthropic', buckets(100, 20, 10), t0)
check('a fresh entry log gets one row', entries.length === 1)
check('the entry carries its own timestamp', entries[0]?.at === t0)
check('the entry carries every bucket', entries[0]?.cacheReadTokens === 10)

entries = recordUsageEntry(entries, 'anthropic', buckets(50, 10), t0 + hour)
entries = recordUsageEntry(entries, 'zai', buckets(30, 5), t0 + hour)
check('later turns append rather than replace', entries.length === 3)

const zeroDelta = recordUsageEntry(entries, 'anthropic', noBuckets(), t0 + 2 * hour)
check('a turn with no measured usage adds no entry', zeroDelta.length === entries.length)

// windowUsage over a short window excludes what fell outside it.
const sessionWindow = windowUsage(entries, SESSION_MS, t0 + hour)
check('a window includes entries inside it', sessionWindow['anthropic']?.uncachedInputTokens === 150)
check('a window carries the cache buckets through', sessionWindow['anthropic']?.cacheReadTokens === 10)
check('a window sums every provider active inside it', sessionWindow['zai']?.uncachedInputTokens === 30)

const tinyWindow = windowUsage(entries, 1, t0 + hour + 2 * hour)
check('a window far past every entry includes nothing', Object.keys(tinyWindow).length === 0)

const wideWindow = windowUsage(entries, WEEK_MS, t0 + hour)
check(
  'a window wide enough to cover everything matches the lifetime totals',
  wideWindow['anthropic']?.uncachedInputTokens === 150,
)

// Pruning: an entry older than WEEK_MS relative to the newest write is dropped.
let pruning: UsageEntry[] = []
pruning = recordUsageEntry(pruning, 'anthropic', buckets(10, 0), t0)
pruning = recordUsageEntry(pruning, 'anthropic', buckets(10, 0), t0 + WEEK_MS + hour)
check('an entry older than the longest window is pruned on the next write', pruning.length === 1)
check('the surviving entry is the newer one', pruning[0]?.at === t0 + WEEK_MS + hour)

// A write that itself carries no usage still prunes stale entries.
let pruneOnly: UsageEntry[] = [{ provider: 'anthropic', ...buckets(5, 0), at: t0 }]
pruneOnly = recordUsageEntry(pruneOnly, 'anthropic', noBuckets(), t0 + WEEK_MS + hour)
check('a zero-delta write still prunes what is now stale', pruneOnly.length === 0)

// ------------------------------------------------------- DeepSeek peak hours

// Wednesday 2024-01-03 02:00 UTC — inside the 01:00-04:00 peak window.
const peakMoment = Date.UTC(2024, 0, 3, 2, 0, 0)
const peakStatus = deepSeekPeakStatus(peakMoment)
check('01:00-04:00 UTC on a weekday is peak', peakStatus.peak === true)
check('the next transition from inside a peak window is its own end (04:00)', peakStatus.changesAt === Date.UTC(2024, 0, 3, 4, 0, 0))

// The same Wednesday at 05:00 UTC — the gap between the two peak windows.
const gapMoment = Date.UTC(2024, 0, 3, 5, 0, 0)
const gapStatus = deepSeekPeakStatus(gapMoment)
check('05:00 UTC, between the two peak windows, is off-peak', gapStatus.peak === false)
check('off-peak in the gap transitions at the next window\'s start (06:00)', gapStatus.changesAt === Date.UTC(2024, 0, 3, 6, 0, 0))

// Wednesday 10:30 UTC — just past the second window closes.
const eveningMoment = Date.UTC(2024, 0, 3, 10, 30, 0)
const eveningStatus = deepSeekPeakStatus(eveningMoment)
check('10:30 UTC, after the second window, is off-peak', eveningStatus.peak === false)
check('off-peak in the evening transitions at tomorrow\'s first window (01:00)', eveningStatus.changesAt === Date.UTC(2024, 0, 4, 1, 0, 0))

// Saturday — entirely off-peak regardless of hour.
const saturdayMoment = Date.UTC(2024, 0, 6, 2, 0, 0) // 2024-01-06 is a Saturday
const saturdayStatus = deepSeekPeakStatus(saturdayMoment)
check('02:00 UTC on a Saturday is off-peak even though the hour matches a weekday window', saturdayStatus.peak === false)
check('the weekend transitions at Monday\'s first window', saturdayStatus.changesAt === Date.UTC(2024, 0, 8, 1, 0, 0))

// Friday afternoon, the longest off-peak stretch the schedule allows.
const fridayAfternoon = Date.UTC(2024, 0, 5, 15, 0, 0) // 2024-01-05 is a Friday
const fridayStatus = deepSeekPeakStatus(fridayAfternoon)
check('Friday afternoon is off-peak', fridayStatus.peak === false)
check('the long weekend stretch still resolves within the search window', fridayStatus.changesAt === Date.UTC(2024, 0, 8, 1, 0, 0))

check('a provider id containing "deepseek" is recognized', looksLikeDeepSeek('deepseek') === true)
check('a provider id is matched case-insensitively', looksLikeDeepSeek('DeepSeek-Official') === true)
check('an unrelated provider id is not', looksLikeDeepSeek('anthropic') === false)

if (failed > 0) {
  console.error(`${String(failed)} usage checks failed`)
  process.exit(1)
}
console.log(`ok - ${String(passed)} usage checks passed`)
