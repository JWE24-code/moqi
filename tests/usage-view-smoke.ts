/**
 * `/usage` pane smoke: the two halves of the dashboard — the provider plans on
 * top, the local billed-token ledger below — and the states in between.
 */

import { recordUsage, type UsageLedger } from '../src/usage.ts'
import { UsageView, renderUsagePane } from '../src/tui/usage-view.ts'
import type { ProviderPlan } from '../src/tui/credits.ts'
import { stripAnsi, displayWidth } from '../src/tui/text.ts'

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
function buckets(uncached: number, output: number, cacheRead = 0, cacheWrite = 0) {
  return {
    uncachedInputTokens: uncached,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  }
}

// ------------------------------------------------------------------- empty

const empty = new UsageView()
const emptyLines = renderUsagePane(empty, 80).map(stripAnsi)
check('an empty view says nothing is recorded yet', emptyLines.some((line) => line.includes('nothing recorded yet')))
check('an empty view still carries the heading', emptyLines.some((line) => line.includes('Usage')))
check('an empty view carries no window headings', !emptyLines.some((line) => line.includes('session (5h)')))

// --------------------------------------------------------------- probe pending

const pending = new UsageView()
pending.setPlansPending()
const pendingLines = renderUsagePane(pending, 80).map(stripAnsi)
check('a pane whose plan probe is still out says so', pendingLines.some((line) => line.includes('Checking provider plans')))

// Once answers land, the pending line goes away even if the answers were empty.
pending.setPlans([], 0)
const settledLines = renderUsagePane(pending, 80).map(stripAnsi)
check('a settled probe stops saying it is checking', !settledLines.some((line) => line.includes('Checking provider plans')))

// -------------------------------------------------------- tokens, with data

let anthropic: UsageLedger = {}
anthropic = recordUsage(anthropic, 'anthropic', buckets(2000, 300))
let zai: UsageLedger = {}
zai = recordUsage(zai, 'zai', buckets(500, 100))
const lifetime: UsageLedger = { ...anthropic, ...zai }

const view = new UsageView()
view.setData(anthropic, lifetime, lifetime, 0)
const raw = renderUsagePane(view, 80)
const lines = raw.map(stripAnsi)

check(
  'all three windows are headed',
  ['session (5h)', 'week (7d)', 'lifetime'].every((label) => lines.some((line) => line.includes(label))),
)
check('a provider absent from the session window is not listed there', (() => {
  const sessionStart = lines.findIndex((line) => line.includes('session (5h)'))
  const weekStart = lines.findIndex((line) => line.includes('week (7d)'))
  const sessionBlock = lines.slice(sessionStart, weekStart).join('\n')
  return sessionBlock.includes('anthropic') && !sessionBlock.includes('zai')
})())
check('a provider present in a wider window is listed there', (() => {
  const weekStart = lines.findIndex((line) => line.includes('week (7d)'))
  const lifetimeStart = lines.findIndex((line) => line.includes('lifetime'))
  const weekBlock = lines.slice(weekStart, lifetimeStart).join('\n')
  return weekBlock.includes('anthropic') && weekBlock.includes('zai')
})())
check('token counts are grouped with commas', lines.some((line) => line.includes('2,300')))
check('a row splits prompt from output, which are priced differently', lines.some((line) => line.includes('↑2,000 ↓300')))
check('no rendered line exceeds the requested width', raw.every((line) => displayWidth(stripAnsi(line)) <= 80))

// Providers keep the same color across sections: the ANSI prefix immediately
// before the literal name "anthropic" is byte-identical everywhere it appears
// (week and lifetime both list it; session does not).
const anthropicPrefixes = raw
  .filter((line) => line.includes('anthropic'))
  .map((line) => line.slice(0, line.indexOf('anthropic')))
check('anthropic appears in more than one section, so this check exercises something', anthropicPrefixes.length >= 2)
check('a provider keeps the same color in every section it appears in', new Set(anthropicPrefixes).size === 1)

// A cache hit rate is surfaced only when there is one to report.
const cached = new UsageView()
let cachedLedger: UsageLedger = {}
cachedLedger = recordUsage(cachedLedger, 'anthropic', buckets(750, 100, 250))
cached.setData(cachedLedger, cachedLedger, cachedLedger, 0)
const cachedLines = renderUsagePane(cached, 100).map(stripAnsi)
check('a route served partly from cache reports its hit rate', cachedLines.some((line) => line.includes('25% cached')))
check('a route with no cache reads reports no rate at all', !lines.some((line) => line.includes('cached')))

// -------------------------------------------------------------- narrow width

const narrow = renderUsagePane(view, 40).map(stripAnsi)
check('a narrow width is respected, not just the default 80', narrow.every((line) => displayWidth(line) <= 40))

// ------------------------------------------------------------- plans on top

const plans: ProviderPlan[] = [
  {
    provider: 'deepseek',
    displayName: 'DeepSeek',
    windows: [],
    notes: [{ level: 'ok', text: '✓ off-peak now (half price) — peak resumes in 3h 0m' }],
    balance: { total: 14.5, granted: 10, toppedUp: 4.5, currency: 'USD', available: true },
  },
  {
    provider: 'zai',
    displayName: 'z.ai (GLM coding plan)',
    plan: 'GLM Coding Max',
    windows: [
      { label: 'Session (5h)', used: 1650, limit: 5000, unit: 'credits', resetAt: 2 * 60 * 60 * 1000 },
      { label: 'Week (7d)', used: 4800, limit: 5000, unit: 'credits' },
    ],
    notes: [],
  },
  {
    provider: 'anthropic',
    displayName: 'Claude',
    windows: [],
    notes: [],
    problem: 'not signed in — run /providers to connect a Claude plan',
  },
]
const withPlans = new UsageView()
withPlans.setData({}, {}, {}, 0)
withPlans.setPlans(plans, 0)
const planRaw = renderUsagePane(withPlans, 100)
const planLines = planRaw.map(stripAnsi)

check('the plans section is headed', planLines.some((line) => line.includes('Plans & limits')))
check('a balance is shown with its currency', planLines.some((line) => line.includes('14.5 USD')))
check('a balance splits granted from topped up', planLines.some((line) => line.includes('10 granted') && line.includes('4.5 topped up')))
check('a plan tier is shown next to its provider', planLines.some((line) => line.includes('GLM Coding Max')))
check('a quota window shows used against limit', planLines.some((line) => line.includes('1,650/5,000')))
check('a quota window shows its percentage', planLines.some((line) => line.includes('33%')))
check('a window with a reset time counts down to it', planLines.some((line) => line.includes('resets in 2h 0m')))
check('a window with no reset time simply omits the countdown', (() => {
  const week = planLines.find((line) => line.includes('Week (7d)'))
  return week !== undefined && !week.includes('resets in')
})())
check('a provider that could not be read explains why', planLines.some((line) => line.includes('not signed in')))
check('a DeepSeek peak note rides along with its provider', planLines.some((line) => line.includes('off-peak now')))
check('no plan line exceeds the requested width', planRaw.every((line) => displayWidth(stripAnsi(line)) <= 100))

// A nearly-spent window must be visually distinct from a roomy one: the bar's
// own color changes, so the ANSI prefixes of the two rows cannot match.
const sessionRow = planRaw.find((line) => stripAnsi(line).includes('Session (5h)'))
const weekRow = planRaw.find((line) => stripAnsi(line).includes('Week (7d)'))
check('a 33% window and a 96% window are drawn in different colors', (() => {
  if (sessionRow === undefined || weekRow === undefined) return false
  const colorOf = (line: string): string => line.slice(line.indexOf('█') - 12, line.indexOf('█'))
  return colorOf(sessionRow) !== colorOf(weekRow)
})())

if (failed > 0) {
  console.error(`${String(failed)} usage-view checks failed`)
  process.exit(1)
}
console.log(`ok - ${String(passed)} usage-view checks passed`)
