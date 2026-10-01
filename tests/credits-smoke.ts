/**
 * Credit-probe smoke: the parsers that turn a provider's response into plan
 * blocks, and the collector that keeps one provider's failure from emptying the
 * pane.
 *
 * These parsers are the part of `/usage` most able to put a confident wrong
 * number on screen, which is the failure the whole feature exists to correct —
 * so the cases that matter most here are the negative ones: a field missing, a
 * field of the wrong type, an envelope that is not the shape expected. Every one
 * of them must yield "could not be read", never a zero.
 */

import {
  collectPlans,
  deepSeekNotes,
  anthropicNotes,
  hasProbe,
  friendlyName,
  PlanCache,
  PLAN_CACHE_TTL_MS,
  CODEX_USAGE_URL,
  DEEPSEEK_BALANCE_URL,
  ZAI_QUOTA_URL,
  type CredentialLookup,
  type FetchLike,
} from '../src/credits.ts'
import {
  anthropicBreakdownNotes,
  codexWindowLabel,
  countdown,
  money,
  parseAnthropicUsage,
  parseCodexUsage,
  parseDeepSeekBalance,
  parseZaiPlan,
  parseZaiQuota,
  renderPlans,
  windowColor,
  zaiWindowLabel,
} from '../src/tui/credits.ts'
import { colAccent, colGreen, colRose } from '../src/tui/theme.ts'
import { stripAnsi, displayWidth } from '../src/tui/text.ts'

let passed = 0
let failed = 0
function check(name: string, condition: boolean): void {
  if (condition) {
    passed += 1
  } else {
    failed += 1
    console.error(`FAIL: ${name}`)
  }
}

/** Decimal-string parses are asserted with a tolerance, not exact `===`. */
function closeTo(actual: number | undefined, expected: number): boolean {
  return actual !== undefined && Math.abs(actual - expected) < 1e-9
}

// --------------------------------------------------------- DeepSeek balance

// The documented shape, with the amounts as decimal strings — which is how
// DeepSeek actually sends them.
const deepSeekBody = {
  is_available: true,
  balance_infos: [
    { currency: 'USD', total_balance: '14.32', granted_balance: '10.00', topped_up_balance: '4.32' },
  ],
}
const balance = parseDeepSeekBalance(deepSeekBody)
check('a DeepSeek balance parses', balance !== undefined)
check('numeric strings are read as numbers', closeTo(balance?.total, 14.32))
check('the granted portion is split out', balance?.granted === 10)
check('the topped-up portion is split out', closeTo(balance?.toppedUp, 4.32))
check('the currency is carried through', balance?.currency === 'USD')
check('availability is carried through', balance?.available === true)

const unavailable = parseDeepSeekBalance({ ...deepSeekBody, is_available: false })
check('an unavailable account is reported as such', unavailable?.available === false)

// camelCase spelling of the same payload.
const camel = parseDeepSeekBalance({ isAvailable: true, balanceInfos: [{ currency: 'CNY', totalBalance: 5 }] })
check('the camelCase spelling parses too', camel?.total === 5)
check('a balance with no split reports no granted portion', camel?.granted === undefined)

// The refusals.
check('a body that is not an object yields nothing', parseDeepSeekBalance('nope') === undefined)
check('a null body yields nothing', parseDeepSeekBalance(null) === undefined)
check('an empty balance list yields nothing', parseDeepSeekBalance({ balance_infos: [] }) === undefined)
check('a missing total is a refusal, not a zero', parseDeepSeekBalance({ balance_infos: [{ currency: 'USD' }] }) === undefined)
check(
  'a non-numeric total is a refusal, not a zero',
  parseDeepSeekBalance({ balance_infos: [{ total_balance: 'lots' }] }) === undefined,
)
check(
  'a missing availability flag still yields the balance that is plainly there',
  parseDeepSeekBalance({ balance_infos: [{ total_balance: 3, currency: 'USD' }] })?.available === true,
)

// ------------------------------------------------------------- z.ai windows

check('5 hours is the session window', zaiWindowLabel(5, 3) === 'Session (5h)')
// Unit 6 is weeks, not days: a live `{ number: 1, unit: 6 }` row reset four days
// out, which no daily window can do.
check('1 of unit 6 is the week window', zaiWindowLabel(1, 6) === 'Week (7d)')
check('another hour count is labelled as hours', zaiWindowLabel(3, 3) === 'Window (3h)')
check('another week count is labelled as weeks', zaiWindowLabel(4, 6) === 'Window (4w)')
check('an unknown unit falls back to a plain label', zaiWindowLabel(5, 99) === 'Quota')
check('a missing count falls back to a plain label', zaiWindowLabel(undefined, 3) === 'Quota')

// The real payload, field for field, as the live endpoint returns it. Note that
// `usage` is the LIMIT and `currentValue` is what has been consumed — the
// inversion this parser exists to get right.
const zaiQuotaBody = {
  code: 200,
  msg: 'Operation successful',
  data: {
    limits: [
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 14, remaining: 1985, percentage: 1, nextResetTime: 1_790_442_048_272 },
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 10000, currentValue: 6159, remaining: 3840, percentage: 61, nextResetTime: 1_790_792_244_979 },
    ],
    level: 'lite',
  },
  success: true,
}
const zaiQuota = parseZaiQuota(zaiQuotaBody)
check('every credit limit becomes a window', zaiQuota.length === 2)
check('the session window is labelled from its unit code', zaiQuota[0]?.label === 'Session (5h)')
check('the weekly window is labelled from unit 6', zaiQuota[1]?.label === 'Week (7d)')
// The whole point: 14 used out of 2000, not 2000 used out of something.
check('currentValue is the used figure, not `usage`', zaiQuota[0]?.used === 14)
check('`usage` is the limit, not the used figure', zaiQuota[0]?.limit === 2000)
check('a barely-touched window reads as barely touched', Math.round((zaiQuota[0]!.used / zaiQuota[0]!.limit) * 100) === 1)
check('the weekly window reads its own pair the same way', zaiQuota[1]?.used === 6159 && zaiQuota[1]?.limit === 10000)
check('a reset time is carried through', zaiQuota[0]?.resetAt === 1_790_442_048_272)
check('windows are counted in credits', zaiQuota[0]?.unit === 'credits')

// The cross-check: a payload whose `remaining` contradicts the pair means the
// field meanings have changed, and the row is refused rather than inverted.
const contradictory = parseZaiQuota({
  data: { limits: [{ type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 14, remaining: 50 }] },
})
check('a row whose remaining contradicts its pair is refused', contradictory.length === 0)
check('an off-by-one remaining is tolerated, since the API exhibits it', parseZaiQuota({
  data: { limits: [{ type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 14, remaining: 1986 }] },
}).length === 1)

check('a row that is not a credit limit is left out', parseZaiQuota({
  data: { limits: [{ type: 'SOMETHING_ELSE', usage: 10, currentValue: 1 }] },
}).length === 0)
check('a row missing its used figure is dropped rather than zeroed', parseZaiQuota({ data: { limits: [{ usage: 10 }] } }).length === 0)
check('a row missing its limit is dropped', parseZaiQuota({ data: { limits: [{ currentValue: 1 }] } }).length === 0)
check('a zero limit is dropped rather than dividing by it', parseZaiQuota({ data: { limits: [{ usage: 0, currentValue: 0 }] } }).length === 0)
check('a body that is not an object yields no windows', parseZaiQuota(42).length === 0)

// The real subscription payload, including the date-string renewal time.
const zaiPlanBody = {
  code: 200,
  data: [
    {
      productName: 'GLM Coding Lite',
      status: 'VALID',
      renewPrice: 43.2,
      billingCycle: 'quarterly',
      nextRenewTime: '2026-11-30',
    },
  ],
  success: true,
}
const zaiPlan = parseZaiPlan(zaiPlanBody)
check('a plan name parses from productName', zaiPlan?.plan === 'GLM Coding Lite')
check('a date-string renewal parses to epoch millis', zaiPlan?.renewsAt === Date.parse('2026-11-30'))
check('a renewal price parses', closeTo(zaiPlan?.renewPrice, 43.2))
check('a billing cycle parses', zaiPlan?.billingCycle === 'quarterly')

// An expired entry must not win over the live one, whatever the order.
const twoPlans = parseZaiPlan({
  data: [
    { productName: 'Old Lite', status: 'EXPIRED' },
    { productName: 'Current Max', status: 'VALID' },
  ],
})
check('a valid subscription is preferred over an expired one', twoPlans?.plan === 'Current Max')
check('with no valid entry, the first is still reported', parseZaiPlan({ data: [{ productName: 'Only', status: 'EXPIRED' }] })?.plan === 'Only')
check('an epoch renewal number is taken as given', parseZaiPlan({ data: [{ productName: 'X', expireTime: 1234 }] })?.renewsAt === 1234)
check('a subscription list naming nothing yields nothing', parseZaiPlan({ data: [{ id: 7 }] }) === undefined)
check('an empty subscription list yields nothing', parseZaiPlan({ data: [] }) === undefined)

// --------------------------------------------------------- Anthropic windows

// The real payload's own shape: the two windows that matter, surrounded by a
// long tail of nulls and unrelated buckets the parser must simply ignore.
const anthropicReal = parseAnthropicUsage({
  five_hour: { utilization: 85, resets_at: '2026-09-26T16:20:00.236313+00:00', limit_dollars: null, used_dollars: null },
  seven_day: { utilization: 25, resets_at: '2026-10-03T01:00:00.236336+00:00', limit_dollars: null },
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: { is_enabled: false, monthly_limit: null, utilization: null },
  spend: { percent: 0, limit: null },
})
check('the live Anthropic payload yields exactly two windows', anthropicReal.length === 2)
check('the session utilization is read from the live payload', anthropicReal[0]?.used === 85)
check('the week utilization is read from the live payload', anthropicReal[1]?.used === 25)
check('a fractional-second ISO instant still parses', anthropicReal[0]?.resetAt === Date.parse('2026-09-26T16:20:00.236313+00:00'))
check('null sibling buckets are ignored rather than drawn', !anthropicReal.some((w) => w.label.includes('opus')))
check(
  'a null utilization elsewhere in the payload does not become a window',
  anthropicReal.every((w) => w.used === 85 || w.used === 25),
)

const anthropicWindows = parseAnthropicUsage({
  five_hour: { utilization: 42, resets_at: '2026-09-26T18:00:00Z' },
  seven_day: { utilization: 91, resets_at: '2026-10-01T00:00:00Z' },
})
check('both Claude plan windows parse', anthropicWindows.length === 2)
check('the session window comes first', anthropicWindows[0]?.label === 'Session (5h)')
check('utilization is read as a percentage of 100', anthropicWindows[0]?.used === 42 && anthropicWindows[0]?.limit === 100)
check('a percentage window carries its unit', anthropicWindows[0]?.unit === '%')
check('an ISO reset instant is parsed to epoch millis', anthropicWindows[0]?.resetAt === Date.parse('2026-09-26T18:00:00Z'))
check('the week window parses independently', anthropicWindows[1]?.used === 91)

check('camelCase spellings parse', parseAnthropicUsage({ fiveHour: { utilization: 5 } }).length === 1)
check('an epoch reset number is taken as given', parseAnthropicUsage({ five_hour: { utilization: 5, resets_at: 1234 } })[0]?.resetAt === 1234)
check('an unparseable reset date is dropped rather than read as 1970', parseAnthropicUsage({ five_hour: { utilization: 5, resets_at: 'soon' } })[0]?.resetAt === undefined)
check('a window with no utilization figure is not drawn', parseAnthropicUsage({ five_hour: { foo: 1 } }).length === 0)
check('a response describing neither window yields nothing', parseAnthropicUsage({}).length === 0)
check('a body that is not an object yields nothing', parseAnthropicUsage([]).length === 0)
check('only one window present yields only that one', parseAnthropicUsage({ seven_day: { utilization: 3 } }).length === 1)

// A nearly-spent window earns a warning; a roomy one does not.
check('a window over 90% spent warns', anthropicNotes(anthropicWindows).length === 1)
check('the warning names the window it is about', anthropicNotes(anthropicWindows)[0]?.text.includes('Week (7d)') === true)
check('a roomy window earns no warning', anthropicNotes([{ label: 'Session (5h)', used: 10, limit: 100 }]).length === 0)

// ------------------------------------------------------------ DeepSeek notes

// Wednesday 02:00 UTC — inside the 01:00-04:00 peak window.
const peakNotes = deepSeekNotes(Date.UTC(2026, 0, 7, 2, 0, 0))
check('at peak, the first note warns about pricing', peakNotes[0]?.level === 'warn')
check('the peak note says off-peak is half price', peakNotes[0]?.text.includes('half price') === true)
check('the peak note counts down to the flip', /in \d+h \d+m|in \d+m/.test(peakNotes[0]?.text ?? '') === true)
check('at peak, a second note explains the throughput cost', peakNotes[1]?.text.includes('slower') === true)
check(
  'the throughput note is explicit that no limit is enforced, since that is the surprising part',
  peakNotes[1]?.text.includes('no request limit') === true,
)

// The same Wednesday at 05:00 UTC — between the two peak windows.
const offPeakNotes = deepSeekNotes(Date.UTC(2026, 0, 7, 5, 0, 0))
check('off peak, the first note is reassuring', offPeakNotes[0]?.level === 'ok')
check('the off-peak note says peak resumes', offPeakNotes[0]?.text.includes('peak resumes') === true)
check('off peak, the second note mentions the speed benefit', offPeakNotes[1]?.text.includes('less queueing') === true)

// ------------------------------------------------------------------ probing

check('a DeepSeek route has a probe', hasProbe('deepseek'))
check('a route id with a suffix still matches', hasProbe('deepseek-chat'))
check('a z.ai route has a probe', hasProbe('zai'))
check('a GLM route matches z.ai', hasProbe('glm-coding'))
check('an Anthropic route has a probe', hasProbe('anthropic'))
check('a Claude-named route matches Anthropic', hasProbe('claude-pro'))
check('an unknown route has no probe', !hasProbe('some-local-llama'))

// An OAuth-only route is configured empty, so the adapter hands back the bare id
// and `/usage` supplies a readable name rather than heading a Claude plan block
// with "anthropic".
check('an unlabelled Anthropic route gets a readable name', friendlyName('anthropic', 'anthropic') === 'Claude (Pro/Max)')
check('an unlabelled Codex route gets a readable name', friendlyName('openai-codex', 'openai-codex') === 'OpenAI Codex (ChatGPT)')
check('an unlabelled DeepSeek route gets a readable name', friendlyName('deepseek', 'deepseek') === 'DeepSeek')
check('an empty display name still yields something', friendlyName('mystery', '') === 'mystery')
check('a name the adapter did supply always wins', friendlyName('zai', 'z.ai (GLM coding plan)') === 'z.ai (GLM coding plan)')
check('an adapter label wins even for a known route', friendlyName('anthropic', 'Work Claude') === 'Work Claude')

// -------------------------------------------------------------- collectPlans

/** A lookup that has both keys and one grant. */
const lookup: CredentialLookup = {
  resolveKey: async (name) => (name === 'DEEPSEEK_API_KEY' ? 'ds-test' : undefined),
  readGrantToken: async () => undefined,
}

/** A fetch that answers DeepSeek and refuses everything else. */
const fetchImpl: FetchLike = async (url) => {
  if (url === DEEPSEEK_BALANCE_URL) {
    return { ok: true, status: 200, json: async () => deepSeekBody }
  }
  return { ok: false, status: 500, json: async () => ({}) }
}

const collected = await collectPlans(
  [
    { provider: 'deepseek', displayName: 'DeepSeek' },
    { provider: 'zai', displayName: 'z.ai' },
    { provider: 'anthropic', displayName: 'Claude' },
    { provider: 'some-local-llama', displayName: 'Local' },
  ],
  lookup,
  fetchImpl,
  () => 1_700_000_000_000,
)

check('one block comes back per probeable route', collected.length === 3)
check('a route with no probe is left out entirely', !collected.some((plan) => plan.provider === 'some-local-llama'))
const ds = collected.find((plan) => plan.provider === 'deepseek')
check('a provider that answered carries its balance', closeTo(ds?.balance?.total, 14.32))
check('a provider that answered has no problem line', ds?.problem === undefined)
check('DeepSeek carries its peak notes even alongside a balance', (ds?.notes.length ?? 0) >= 1)

const zai = collected.find((plan) => plan.provider === 'zai')
check('a provider with no stored key says so rather than failing', zai?.problem?.includes('ZAI_API_KEY') === true)
const claude = collected.find((plan) => plan.provider === 'anthropic')
check('a provider with no sign-in points at /providers', claude?.problem?.includes('/providers') === true)

// An HTTP failure becomes that provider's own line, not an exception.
const failingLookup: CredentialLookup = {
  resolveKey: async () => 'key',
  readGrantToken: async () => 'token',
}
const failing = await collectPlans(
  [{ provider: 'zai', displayName: 'z.ai' }],
  failingLookup,
  async () => ({ ok: false, status: 500, json: async () => ({}) }),
  () => 0,
)
check('an HTTP error is reported on the provider block', failing[0]?.problem?.includes('HTTP 500') === true)

// 401 is translated, because "HTTP 401" sends nobody anywhere useful.
const expired = await collectPlans(
  [{ provider: 'anthropic', displayName: 'Claude' }],
  failingLookup,
  async () => ({ ok: false, status: 401, json: async () => ({}) }),
  () => 0,
)
check('a 401 is translated into what to do about it', expired[0]?.problem?.includes('/providers') === true)

// A probe that throws outright is still contained.
const thrown = await collectPlans(
  [{ provider: 'deepseek', displayName: 'DeepSeek' }],
  failingLookup,
  () => {
    throw new Error('socket exploded')
  },
  () => 0,
)
check('a thrown probe becomes a problem line rather than a rejection', thrown[0]?.problem === 'socket exploded')
check('a contained throw still leaves the block usable', thrown[0]?.provider === 'deepseek')

// One slow provider must not stop the others from being reported.
const mixed = await collectPlans(
  [
    { provider: 'deepseek', displayName: 'DeepSeek' },
    { provider: 'zai', displayName: 'z.ai' },
  ],
  { resolveKey: async () => 'key', readGrantToken: async () => undefined },
  async (url) =>
    url === DEEPSEEK_BALANCE_URL
      ? { ok: true, status: 200, json: async () => deepSeekBody }
      : { ok: false, status: 503, json: async () => ({}) },
  () => 0,
)
check('a healthy provider still reports when another is down', mixed.find((p) => p.provider === 'deepseek')?.balance !== undefined)
check('the down provider is the only one carrying a problem', mixed.find((p) => p.provider === 'zai')?.problem !== undefined)

// z.ai that answers but reports no credit windows says so rather than drawing none.
const emptyQuota = await collectPlans(
  [{ provider: 'zai', displayName: 'z.ai' }],
  { resolveKey: async () => 'key', readGrantToken: async () => undefined },
  async (url) => ({
    ok: true,
    status: 200,
    json: async () => (url === ZAI_QUOTA_URL ? { data: [] } : { data: [{ planName: 'Lite' }] }),
  }),
  () => 0,
)
check('a plan with no reported windows explains itself', emptyQuota[0]?.problem?.includes('no credit windows') === true)
check('the plan name is still shown even when the quota was empty', emptyQuota[0]?.plan === 'Lite')

// ------------------------------------------------- Anthropic severity & split

// The live payload's limits[] array, as captured from the real endpoint: the
// session row is critical at 94%, the weekly row normal at 26%, and the weekly
// row arrives is_active:false while describing the week that is drawn — which
// is why the parser must not consult that flag.
const withLimits = parseAnthropicUsage({
  five_hour: { utilization: 94, resets_at: '2026-09-26T16:19:59.779583+00:00' },
  seven_day: { utilization: 26, resets_at: '2026-10-03T00:59:59.779602+00:00' },
  limits: [
    { kind: 'session', group: 'session', percent: 94, severity: 'critical', resets_at: '2026-09-26T16:19:59.779583+00:00', scope: null, is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: 26, severity: 'normal', resets_at: '2026-10-03T00:59:59.779602+00:00', scope: null, is_active: false },
  ],
})
check('a stated severity attaches to its window', withLimits[0]?.severity === 'critical')
check('the weekly row is matched even when is_active is false', withLimits[1]?.severity === 'normal')

check('an unknown limit kind does not leak onto a window', parseAnthropicUsage({ five_hour: { utilization: 5 }, limits: [{ kind: 'other', severity: 'warning' }] })[0]?.severity === undefined)
check('a limits array of unrecognized shape leaves severity unset', parseAnthropicUsage({ five_hour: { utilization: 5 }, limits: 'nope' })[0]?.severity === undefined)
check('a severity spelled with the synonym field still parses', parseAnthropicUsage({ seven_day: { utilization: 5 }, limits: [{ kind: 'weekly_all', level: 'warning' }] })[0]?.severity === 'warning')

// The severity colors the bar the provider's way, not the local-percentage way.
check('a critical reading is red even below the local red threshold', windowColor(0.6, 'critical') === windowColor(0.99, undefined))
check('a critical reading is red where the local rule would say green', windowColor(0.6, 'critical') === colRose)
check('a warning reading is amber at any share', windowColor(0.1, 'warning') === colAccent)
check('a normal reading is green even at the local red threshold', windowColor(0.99, 'normal') === colGreen)
check('an unrecognized severity falls back to local thresholds', windowColor(0.95, 'spooky') === colRose)
check('no severity keeps the local thresholds', windowColor(0.8, undefined) === colAccent)

// The breakdown names the surfaces that spent the week, in the response's order.
const breakdownBody = {
  seven_day_breakdown: {
    as_of: '2026-09-26T13:32:02.802132+00:00',
    window_started_at: '2026-09-26T00:59:59.779602+00:00',
    rows: [
      { key: 'claude_code', display_name: 'Claude Code', percent: 100 },
      { key: 'chat', display_name: 'Chats', percent: 0 },
      { key: 'cowork', display_name: 'Cowork', percent: 0 },
      { key: 'other', display_name: 'Other', percent: 0 },
    ],
  },
}
const breakdown = anthropicBreakdownNotes(breakdownBody)
check('a spent week names the surface that spent it', breakdown[0]?.text.includes('Claude Code') === true)
check('a surface at zero percent is not listed', breakdown[0]?.text.includes('Chats') === false)
check('a breakdown with nothing spent says nothing', anthropicBreakdownNotes({ seven_day_breakdown: { rows: [{ display_name: 'Chats', percent: 0 }] } }).length === 0)
check('a missing breakdown says nothing', anthropicBreakdownNotes({}).length === 0)
check('a malformed breakdown says nothing rather than guessing', anthropicBreakdownNotes({ seven_day_breakdown: { rows: 7 } }).length === 0)

// ------------------------------------------------------------------- Codex

// The schema two independent reverse-engineered trackers agree on for
// GET /backend-api/wham/usage: plan tier, two percentage windows with
// seconds-denominated resets, and an optional credit balance.
const codexBody = {
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 6, reset_at: 1_738_300_000, limit_window_seconds: 18_000 },
    secondary_window: { used_percent: 24, reset_at: 1_738_900_000, limit_window_seconds: 604_800 },
  },
  credits: { has_credits: true, unlimited: false, balance: 820.6969075 },
}
const codexParsed = parseCodexUsage(codexBody)
check('the documented Codex payload yields both windows', codexParsed?.windows.length === 2)
check('the plan tier parses', codexParsed?.plan === 'plus')
check('the 5h window gets the session label', codexParsed?.windows[0]?.label === 'Session (5h)')
check('the 7d window gets the week label', codexParsed?.windows[1]?.label === 'Week (7d)')
check('utilization is a percentage of 100', codexParsed?.windows[0]?.used === 6 && codexParsed?.windows[0]?.limit === 100)
check('a seconds reset is converted to millis', codexParsed?.windows[0]?.resetAt === 1_738_300_000_000)
check('a credit balance parses as credits, not currency', closeTo(codexParsed?.balance?.total, 820.6969075) && codexParsed?.balance?.currency === 'credits')

check('a payload with no secondary window yields only the primary', parseCodexUsage({ rate_limit: { primary_window: { used_percent: 3 } } })?.windows.length === 1)
check('an unrecognized window length is named by that length', codexWindowLabel(9_000) === 'Window (3h)' )
check('a missing window length is still labelled', codexWindowLabel(undefined) === 'Quota')
check('a sub-hour window reads in minutes', codexWindowLabel(1_800) === 'Window (30m)')
check('a has_credits:false balance is ignored', parseCodexUsage({ credits: { has_credits: false, balance: 0 } })?.balance === undefined)
check('a payload with only a plan still parses', parseCodexUsage({ plan_type: 'pro' })?.plan === 'pro')
check('a payload with nothing readable is refused', parseCodexUsage({ rate_limit: {} }) === undefined)
check('a non-object body is refused', parseCodexUsage('nope') === undefined)
check('a window with no utilization is not drawn', parseCodexUsage({ plan_type: 'pro', rate_limit: { primary_window: { reset_at: 5 } } })?.windows.length === 0)

// The probe: signed in, answered, and parsed through the same collectPlans
// containment every other route goes through.
const codexCollected = await collectPlans(
  [{ provider: 'openai-codex', displayName: 'OpenAI Codex (ChatGPT)' }],
  { resolveKey: async () => undefined, readGrantToken: async () => 'token' },
  async (url) =>
    url === CODEX_USAGE_URL
      ? { ok: true, status: 200, json: async () => codexBody }
      : { ok: false, status: 500, json: async () => ({}) },
  () => 1_738_000_000_000,
)
check('a Codex route has a probe', hasProbe('openai-codex'))
check('a ChatGPT-named route matches the Codex probe', hasProbe('chatgpt'))
check('the Codex probe reports both windows', codexCollected[0]?.windows.length === 2)
check('the Codex probe carries the plan tier', codexCollected[0]?.plan === 'plus')
check('the Codex probe carries the credit balance', codexCollected[0]?.balance !== undefined)

const codexUnsigned = await collectPlans(
  [{ provider: 'openai-codex', displayName: 'OpenAI Codex (ChatGPT)' }],
  { resolveKey: async () => undefined, readGrantToken: async () => undefined },
  async () => ({ ok: true, status: 200, json: async () => ({}) }),
  () => 0,
)
check('a Codex route with no sign-in points at /providers', codexUnsigned[0]?.problem?.includes('/providers') === true)

const codexUnreadable = await collectPlans(
  [{ provider: 'openai-codex', displayName: 'OpenAI Codex (ChatGPT)' }],
  { resolveKey: async () => undefined, readGrantToken: async () => 'token' },
  async () => ({ ok: true, status: 200, json: async () => ({ nonsense: 1 }) }),
  () => 0,
)
check('a Codex response of unknown shape refuses rather than improvises', codexUnreadable[0]?.problem?.includes('could not be read') === true)

// --------------------------------------------------------------- PlanCache// An injected clock walks the boundary exactly, which is the only honest way to
// test a TTL.
let clock = 1_000
const cache = new PlanCache(PLAN_CACHE_TTL_MS, () => clock)
check('an empty cache has nothing to give', cache.get() === undefined)
const reading = [{ provider: 'deepseek', displayName: 'DeepSeek', windows: [], notes: [] }]
cache.set(reading)
check('a fresh reading is returned immediately', cache.get() === reading)
clock += PLAN_CACHE_TTL_MS - 1
check('a reading one millisecond short of the TTL is still fresh', cache.get() === reading)
clock += 1
check('a reading past the TTL is gone', cache.get() === undefined)
cache.set(reading)
clock += PLAN_CACHE_TTL_MS
cache.set([...reading, { provider: 'zai', displayName: 'z.ai', windows: [], notes: [] }])
check('a later reading replaces the earlier one', (cache.get()?.length ?? 0) === 2)

// ------------------------------------------------------------- formatting

check('a countdown under an hour reads in minutes', countdown(12 * 60 * 1000) === '12m')
check('a countdown over an hour reads in hours and minutes', countdown((2 * 60 + 5) * 60 * 1000) === '2h 5m')
check('a countdown over a day reads in days and hours', countdown((26 * 60 + 0) * 60 * 1000) === '1d 2h')
check('a countdown already past reads as zero rather than negative', countdown(-5000) === '0m')

check('money trims needless decimals', money(140, 'USD') === '140 USD')
check('money keeps real decimals', money(14.32, 'USD') === '14.32 USD')
check('money rounds to cents', money(1.005999, 'USD') === '1.01 USD')
check('money with no currency is bare', money(3.5, '') === '3.5')

// -------------------------------------------------------------- renderPlans

check('nothing to report renders nothing at all', renderPlans([], 0, 80).length === 0)
const rendered = renderPlans(
  [{ provider: 'deepseek', displayName: 'DeepSeek', windows: [], notes: [], problem: 'no key' }],
  0,
  80,
)
check('a single problem block still gets the heading', stripAnsi(rendered[0] ?? '').includes('Plans & limits'))
check('the problem is stated in the block', rendered.some((line) => stripAnsi(line).includes('no key')))
check('every rendered plan line respects the width', rendered.every((line) => displayWidth(stripAnsi(line)) <= 80))

if (failed > 0) {
  console.error(`${String(failed)} credits checks failed`)
  process.exit(1)
}
console.log(`ok - ${String(passed)} credits checks passed`)
