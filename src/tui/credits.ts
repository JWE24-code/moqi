/**
 * `/usage`'s top half: what each connected provider's plan actually has left,
 * as the provider itself reports it.
 *
 * This is the half the token ledger below it cannot be. A local tally of tokens
 * says what this app sent; it cannot say what a plan's 5-hour window has left,
 * what a prepaid balance is down to, or when either resets — only the provider
 * knows that, and only its own API will say. So `credits.ts` asks, and this
 * module holds every pure piece of that: the shapes, the parsers, and the
 * drawing.
 *
 * The parsers are the point of the split. They are where a wrong guess about a
 * response field would turn into a confident wrong number on screen, which is
 * exactly the failure this whole feature exists to correct — so they live here,
 * where a test can feed them a recorded response, and they are written to
 * *refuse* rather than improvise: a field that is missing or the wrong type
 * yields `undefined` and an honest "couldn't read this" line, never a zero
 * dressed up as a measurement.
 *
 * Pure like the rest of `tui/`: no Harness, no network, no clock.
 * @module
 */

import { CHART_WIDTH, filledWidth, grouped } from '../usage.ts'
import { displayWidth, padEnd, truncate } from './text.ts'
import { bold, colAccent, colGreen, colRose, muted, ok, style, warn } from './theme.ts'

/** One rolling quota window a provider enforces and reports. */
export interface CreditWindow {
  /** How the provider describes the window, e.g. `Session (5h)`, `Week (7d)`. */
  label: string
  used: number
  limit: number
  /** What is being counted — `credits`, `prompts`. Omitted when unitless. */
  unit?: string
  /** Epoch millis the window next resets, when the provider says. */
  resetAt?: number
  /**
   * How pressed the provider itself considers the window, in the provider's own
   * vocabulary — Anthropic's usage report states `normal`, `warning`, and
   * `critical` per window. Carried verbatim rather than translated so an
   * unknown value falls back to local thresholds instead of being misread.
   */
  severity?: string
}

/** A prepaid or pay-as-you-go money balance. */
export interface CreditBalance {
  total: number
  /** The free/granted portion, when the provider splits it out. */
  granted?: number
  /** The portion the user paid for, when the provider splits it out. */
  toppedUp?: number
  /** ISO-ish currency code as the provider reports it, e.g. `USD`, `CNY`. */
  currency: string
  /** Whether the provider considers the account usable right now. */
  available: boolean
}

/** A one-line remark under a provider: pricing state, a throughput caveat. */
export interface PlanNote {
  level: 'ok' | 'warn' | 'info'
  text: string
}

/** Everything `/usage` knows about one provider's plan at one moment. */
export interface ProviderPlan {
  /** Route id as the Harness knows it, e.g. `deepseek`, `zai`, `anthropic`. */
  provider: string
  /** Name to show, falling back to the route id. */
  displayName: string
  /** Plan or tier name, when the provider states one. */
  plan?: string
  balance?: CreditBalance
  /** Enforced windows, in the order they should be drawn. */
  windows: CreditWindow[]
  notes: PlanNote[]
  /**
   * Why there is nothing to show. Set when the provider is not configured, the
   * request failed, or the response could not be understood — always in the
   * user's terms, never a raw stack.
   */
  problem?: string
}

// ------------------------------------------------------------- safe accessors

/** A JSON object, or undefined when the value is anything else. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** A finite number, or undefined — a numeric string counts, `null` does not. */
function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** A non-empty string, or undefined. */
function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** An array, or undefined. */
function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

/**
 * Read the first key that is present, so one parser tolerates the two spellings
 * an API may use for the same field (`total_balance` / `totalBalance`) without a
 * separate branch per provider.
 */
function pick(record: Record<string, unknown>, ...keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key]
  }
  return undefined
}

// ---------------------------------------------------------------- DeepSeek

/**
 * Parse DeepSeek's `GET /user/balance`.
 *
 * The documented shape is `{ is_available, balance_infos: [{ currency,
 * total_balance, granted_balance, topped_up_balance }] }`, with the amounts as
 * decimal strings rather than numbers — hence {@link asNumber} accepting a
 * numeric string. The first entry is used: the array exists so an account can
 * hold several currencies, and a terminal pane showing one line wants the
 * primary one rather than a sum of incomparable currencies.
 */
export function parseDeepSeekBalance(body: unknown): CreditBalance | undefined {
  const root = asRecord(body)
  if (root === undefined) return undefined
  const infos = asArray(pick(root, 'balance_infos', 'balanceInfos'))
  const first = infos === undefined ? undefined : asRecord(infos[0])
  if (first === undefined) return undefined
  const total = asNumber(pick(first, 'total_balance', 'totalBalance'))
  if (total === undefined) return undefined
  const available = pick(root, 'is_available', 'isAvailable')
  return {
    total,
    granted: asNumber(pick(first, 'granted_balance', 'grantedBalance')),
    toppedUp: asNumber(pick(first, 'topped_up_balance', 'toppedUpBalance')),
    currency: asText(pick(first, 'currency')) ?? '',
    // Absent is treated as available: the balance parsed, and refusing to show
    // a number that is plainly there because one flag is missing would be the
    // wrong trade.
    available: available === undefined ? true : available === true,
  }
}

// -------------------------------------------------------------------- z.ai

/**
 * z.ai reports a window's length as a count plus a unit code: `3` is hours and
 * `6` is weeks, so `{ number: 5, unit: 3 }` is the 5-hour session window and
 * `{ number: 1, unit: 6 }` is the weekly one.
 *
 * The unit codes were read off a live response rather than taken on faith, and
 * the weekly one is why that mattered: `6` is widely described as *days*, which
 * would make `{ number: 1, unit: 6 }` a daily window — but the same row's own
 * `nextResetTime` sat four days out, which no daily window can do. A weekly
 * window anchored to the billing date fits it exactly, and matches the plan
 * z.ai documents (a 5-hour prompt window inside a weekly allowance).
 */
const ZAI_UNIT_HOURS = 3
const ZAI_UNIT_WEEKS = 6

/** `5`,`3` → `Session (5h)`; `1`,`6` → `Week (7d)`; anything else → a plain count. */
export function zaiWindowLabel(count: number | undefined, unit: number | undefined): string {
  if (count === undefined || unit === undefined) return 'Quota'
  if (unit === ZAI_UNIT_HOURS) return count === 5 ? 'Session (5h)' : `Window (${String(count)}h)`
  if (unit === ZAI_UNIT_WEEKS) return count === 1 ? 'Week (7d)' : `Window (${String(count)}w)`
  return 'Quota'
}

/**
 * Parse z.ai's `GET /api/monitor/usage/quota/limit` into one window per
 * reported credit limit.
 *
 * The field naming here is the single most important thing in this module to get
 * right, because it is actively misleading: **`usage` is the window's limit and
 * `currentValue` is what has been consumed**, not the other way round. A parser
 * that took `usage` for the used figure — the obvious reading, and the one this
 * module tried first — would have reported a plan as completely spent while it
 * was 1% used. The names are therefore matched exactly rather than through a
 * list of plausible synonyms, and `remaining` is cross-checked against them so a
 * future rename is caught as a refusal instead of silently inverting the bars.
 *
 * Only rows identifying themselves as a credit limit are taken, and only when
 * both figures are present with a positive limit — a row that cannot be measured
 * is dropped rather than drawn as an empty bar.
 */
export function parseZaiQuota(body: unknown): CreditWindow[] {
  const root = asRecord(body)
  if (root === undefined) return []
  const envelope = asRecord(pick(root, 'data'))
  const rows =
    asArray(envelope?.['limits']) ??
    asArray(pick(root, 'limits')) ??
    asArray(pick(root, 'data', 'list', 'items')) ??
    []
  const windows: CreditWindow[] = []
  for (const raw of rows) {
    const row = asRecord(raw)
    if (row === undefined) continue
    const kind = asText(pick(row, 'type', 'limitType', 'quotaType'))
    // The user-facing quota rows are the credit limits; anything else in the
    // payload is a different concern and is left alone rather than guessed at.
    if (kind !== undefined && !kind.toUpperCase().includes('CREDIT')) continue
    const limit = asNumber(pick(row, 'usage'))
    const used = asNumber(pick(row, 'currentValue'))
    if (used === undefined || limit === undefined || limit <= 0) continue
    // `remaining` must agree with the pair, or the meaning of these fields has
    // changed and nothing here can be trusted. A tolerance of one absorbs the
    // off-by-one rounding the API actually exhibits.
    const remaining = asNumber(pick(row, 'remaining'))
    if (remaining !== undefined && Math.abs(limit - used - remaining) > 1) continue
    windows.push({
      label: zaiWindowLabel(asNumber(pick(row, 'number')), asNumber(pick(row, 'unit', 'wunit'))),
      used,
      limit,
      unit: 'credits',
      resetAt: asNumber(pick(row, 'nextResetTime', 'resetTime', 'nextReset')),
    })
  }
  return windows
}

/** The active plan on a z.ai subscription, as `/usage` reports it. */
export interface ZaiPlan {
  plan: string
  /** Epoch millis of the next renewal, when the response dates one. */
  renewsAt?: number
  /** What the next renewal costs, when the response prices one. */
  renewPrice?: number
  /** `quarterly`, `monthly` — how often that price recurs. */
  billingCycle?: string
}

/**
 * Parse z.ai's `GET /api/biz/subscription/list` for the active plan.
 *
 * A valid subscription is preferred over any other: the list keeps expired and
 * cancelled entries, and the first row is not reliably the live one. Dates here
 * are `YYYY-MM-DD` strings rather than the epoch numbers the quota endpoint
 * uses, so both forms are accepted.
 */
export function parseZaiPlan(body: unknown): ZaiPlan | undefined {
  const root = asRecord(body)
  if (root === undefined) return undefined
  const rows =
    asArray(pick(root, 'data', 'list', 'items')) ??
    asArray(asRecord(pick(root, 'data'))?.['list']) ??
    []
  const parsed: { plan: ZaiPlan; valid: boolean }[] = []
  for (const raw of rows) {
    const row = asRecord(raw)
    if (row === undefined) continue
    const plan = asText(pick(row, 'productName', 'planName', 'name', 'tier', 'packageName'))
    if (plan === undefined) continue
    parsed.push({
      plan: {
        plan,
        renewsAt: epochOrDate(pick(row, 'nextRenewTime', 'expireTime', 'renewTime', 'endTime')),
        renewPrice: asNumber(pick(row, 'renewPrice', 'actualPrice', 'standardPrice')),
        billingCycle: asText(pick(row, 'billingCycle')),
      },
      valid: asText(pick(row, 'status'))?.toUpperCase() === 'VALID',
    })
  }
  return (parsed.find((entry) => entry.valid) ?? parsed[0])?.plan
}

/**
 * A moment stated either as an epoch number or as a date string, in millis.
 *
 * Providers in this module disagree on which they send — sometimes within one
 * account — so both are accepted, and anything unparseable is dropped rather
 * than rendered as 1970.
 */
function epochOrDate(raw: unknown): number | undefined {
  const numeric = asNumber(raw)
  if (numeric !== undefined) return numeric
  const text = asText(raw)
  if (text === undefined) return undefined
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

// --------------------------------------------------------------- Anthropic

/**
 * Parse Anthropic's OAuth usage report into the two windows a Claude Pro/Max
 * plan is actually limited on: the 5-hour session and the 7-day week.
 *
 * Anthropic reports these as *utilization* — a percentage of the window already
 * consumed — rather than as a token count against a token budget, because the
 * budget itself is not published and varies with the plan and the model. A
 * percentage is all that can honestly be shown, so the window is expressed as
 * `used` out of `limit: 100`, carrying its own `%` unit.
 *
 * Both windows are optional and independent: a response that describes only one
 * yields only that one, and a response that describes neither yields nothing at
 * all rather than two empty bars.
 */
export function parseAnthropicUsage(body: unknown): CreditWindow[] {
  const root = asRecord(body)
  if (root === undefined) return []
  const severities = anthropicSeverities(root)
  const windows: CreditWindow[] = []
  const add = (label: string, source: unknown, severity?: string): void => {
    const record = asRecord(source)
    if (record === undefined) return
    const utilization = asNumber(pick(record, 'utilization', 'used_percent', 'usedPercent', 'percent'))
    if (utilization === undefined) return
    windows.push({
      label,
      used: utilization,
      limit: 100,
      unit: '%',
      resetAt: anthropicResetAt(record),
      severity,
    })
  }
  add('Session (5h)', pick(root, 'five_hour', 'fiveHour', 'session'), severities.session)
  add('Week (7d)', pick(root, 'seven_day', 'sevenDay', 'week'), severities.week)
  return windows
}

/**
 * The provider's own severity reading per window, from the `limits[]` array the
 * same response carries alongside the utilization objects.
 *
 * Anthropic states severity per limit row (`normal`, `warning`, `critical`) —
 * a judgement this app would otherwise approximate from the percentage alone,
 * and one only the provider can actually make, because it knows where the real
 * cliff is for the plan and model in use. The row's `kind` names its window
 * (`session`, `weekly_all`, …); kinds are matched by substring rather than an
 * exact table so a renamed or added row still finds its window, and a row whose
 * kind names no window this parser draws is ignored rather than guessed at.
 * `is_active` is deliberately not consulted: the weekly row arrives `false`
 * while describing the very week the `seven_day` object reports.
 *
 * An unrecognized shape yields no severities, and the bars fall back to local
 * thresholds — a downgrade, never a wrong colour.
 */
function anthropicSeverities(root: Record<string, unknown>): { session?: string; week?: string } {
  const rows = asArray(root['limits'])
  const out: { session?: string; week?: string } = {}
  if (rows === undefined) return out
  for (const raw of rows) {
    const row = asRecord(raw)
    if (row === undefined) continue
    const kind = asText(pick(row, 'kind', 'type'))
    const severity = asText(pick(row, 'severity', 'level'))
    if (kind === undefined || severity === undefined) continue
    if (kind.toLowerCase().includes('session')) out.session ??= severity
    else if (kind.toLowerCase().includes('week')) out.week ??= severity
  }
  return out
}

/**
 * Turn `seven_day_breakdown` into a note naming which surfaces spent the week's
 * allowance — the report says what the week went on (`Claude Code`, `Chats`,
 * …), which is the fact that turns "the week is nearly spent" into a decision
 * about where to spend the rest of it.
 *
 * Only surfaces that used some of the week are named, in the response's order;
 * a breakdown where nothing was used yet says nothing rather than listing four
 * zeroes. Percentages are rounded as the provider reports them — no sum, no
 * average, nothing invented.
 */
export function anthropicBreakdownNotes(body: unknown): PlanNote[] {
  const root = asRecord(body)
  if (root === undefined) return []
  const breakdown = asRecord(root['seven_day_breakdown'])
  const rows = asArray(breakdown?.['rows'])
  if (rows === undefined) return []
  const spent: string[] = []
  for (const raw of rows) {
    const row = asRecord(raw)
    if (row === undefined) continue
    const name = asText(pick(row, 'display_name', 'displayName', 'name'))
    const percent = asNumber(pick(row, 'percent', 'share'))
    if (name === undefined || percent === undefined || percent <= 0) continue
    spent.push(`${name} ${String(Math.round(percent))}%`)
  }
  if (spent.length === 0) return []
  return [{ level: 'info', text: `week's allowance went to: ${spent.join(', ')}` }]
}

/**
 * The reset moment on one Anthropic window. Stated as an ISO-8601 instant
 * (`resets_at`), where z.ai uses an epoch number — {@link epochOrDate} takes
 * either.
 */
function anthropicResetAt(record: Record<string, unknown>): number | undefined {
  return epochOrDate(pick(record, 'resets_at', 'resetsAt', 'reset_at', 'resetAt'))
}

// -------------------------------------------------------------------- Codex

/** `GET /backend-api/wham/usage` reports windows in seconds; these are the two. */
const CODEX_WINDOW_5H_SECONDS = 18_000
const CODEX_WINDOW_7D_SECONDS = 604_800

/**
 * A label for a Codex window stated as its length in seconds.
 *
 * The two enforced windows are the same shapes the other providers rate-limit
 * on (5h session, 7d week), so they get the same labels; any other length —
 * OpenAI has changed window sizes before — is named by its own length rather
 * than squeezed into a label that lies about it.
 */
export function codexWindowLabel(seconds: number | undefined): string {
  if (seconds === CODEX_WINDOW_5H_SECONDS) return 'Session (5h)'
  if (seconds === CODEX_WINDOW_7D_SECONDS) return 'Week (7d)'
  if (seconds === undefined) return 'Quota'
  const hours = seconds / 3600
  return hours >= 1 ? `Window (${String(Math.round(hours))}h)` : `Window (${String(Math.round(seconds / 60))}m)`
}

/** What `/usage` could read from Codex's usage report, minus the block framing. */
export interface CodexPlan {
  /** The plan tier as stated, e.g. `plus`, `pro`. */
  plan?: string
  windows: CreditWindow[]
  balance?: CreditBalance
}

/**
 * Parse the ChatGPT/Codex usage report into its enforced windows and any
 * credit balance.
 *
 * This endpoint has no published contract — it is the one the first-party
 * Codex client reads, reverse-engineered independently by more than one
 * third-party tracker, and it has already moved once (from response headers to
 * this dedicated path). The parser is therefore written to the schema those
 * trackers agree on and refuses on anything else: `used_percent` is a 0–100
 * utilization like Anthropic's, so the window is `used` out of `limit: 100`.
 *
 * The one conversion that matters: `reset_at` is a Unix timestamp in
 * **seconds**, where every other reset moment in this app arrives in
 * milliseconds. Multiplying by 1000 is applied before anything else can
 * mistake the figure for a 1970 date.
 *
 * `credits`, when present, is a prepaid balance in OpenAI's own credit units —
 * the API publishes no maximum for it, so it is shown as a balance, never as a
 * bar; a `has_credits: false` row is ignored, since a zero balance on a plan
 * without credits is noise rather than a reading.
 */
export function parseCodexUsage(body: unknown): CodexPlan | undefined {
  const root = asRecord(body)
  if (root === undefined) return undefined
  const rateLimit = asRecord(pick(root, 'rate_limit', 'rateLimit'))
  const windows: CreditWindow[] = []
  const add = (source: unknown): void => {
    const record = asRecord(source)
    if (record === undefined) return
    const used = asNumber(pick(record, 'used_percent', 'usedPercent', 'percent'))
    if (used === undefined) return
    const resetSeconds = asNumber(pick(record, 'reset_at', 'resetAt'))
    windows.push({
      label: codexWindowLabel(asNumber(pick(record, 'limit_window_seconds', 'limitWindowSeconds', 'window_seconds'))),
      used,
      limit: 100,
      unit: '%',
      // Seconds to millis: the app's every other reset moment is millis, and
      // an unconverted seconds figure would read as a reset in 1970.
      resetAt: resetSeconds === undefined ? undefined : resetSeconds * 1000,
    })
  }
  add(pick(rateLimit ?? {}, 'primary_window', 'primaryWindow'))
  add(pick(rateLimit ?? {}, 'secondary_window', 'secondaryWindow'))
  const creditsRow = asRecord(root['credits'])
  const hasCredits = creditsRow?.['has_credits'] === true || creditsRow?.['hasCredits'] === true
  const balance = hasCredits ? asNumber(pick(creditsRow ?? {}, 'balance')) : undefined
  if (windows.length === 0 && balance === undefined && asText(pick(root, 'plan_type', 'planType')) === undefined) {
    return undefined
  }
  return {
    plan: asText(pick(root, 'plan_type', 'planType')),
    windows,
    balance:
      balance === undefined
        ? undefined
        : {
            total: balance,
            // The unit is OpenAI's own credit, not a currency; naming it that
            // way keeps the balance line from implying a dollar figure.
            currency: 'credits',
            available: creditsRow?.['unlimited'] === true || balance > 0,
          },
  }
}

// ------------------------------------------------------------------ drawing

/** `1h 12m` / `4d 9h` / `12m` — the shape every countdown in the app uses. */
export function countdown(ms: number): string {
  const totalMinutes = Math.max(Math.round(ms / 60000), 0)
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${String(days)}d ${String(hours)}h`
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`
  return `${String(minutes)}m`
}

/**
 * A money amount with at most two decimals, trailing zeros trimmed: `12.5`,
 * `0.03`, `140`. A balance is read, not audited, and `140.00` carries no more
 * information than `140` while taking more room in a narrow pane.
 */
export function money(amount: number, currency: string): string {
  const rounded = Math.round(amount * 100) / 100
  const text = String(rounded)
  return currency === '' ? text : `${text} ${currency}`
}

/**
 * Color a utilization bar: by the provider's own severity reading when it gave
 * one, otherwise by how close the window is to its limit.
 *
 * The provider's word wins when available (Anthropic's `critical` colors the
 * bar red at 94% *and would at 60%*, because the provider knows where the real
 * cliff sits for the plan and model in use); the local thresholds are the
 * fallback for providers that report only numbers — a quota is a status
 * reading, not a category, so it earns the status palette either way: green
 * while there is room, amber once most of it is gone, red at the point where
 * the next long turn may be the one that fails.
 *
 * Exported for its test: the colour decision is the behaviour, and asserting
 * against theme-resolved escape codes would tie the test to one palette.
 */
export function windowColor(share: number, severity: string | undefined): typeof colGreen {  if (severity === 'critical') return colRose
  if (severity === 'warning') return colAccent
  if (severity === 'normal') return colGreen
  if (share >= 0.9) return colRose
  if (share >= 0.75) return colAccent
  return colGreen
}

/** One quota window: a labelled bar, its percentage, and when it resets. */
function windowLine(window: CreditWindow, now: number, labelWidth: number, width: number): string {
  const share = window.limit > 0 ? window.used / window.limit : 0
  const filled = filledWidth(share)
  const color = windowColor(share, window.severity)
  const bar = style('█'.repeat(filled), { fg: color }) + muted('░'.repeat(CHART_WIDTH - filled))
  const label = padEnd(truncate(window.label, labelWidth), labelWidth)
  const pct = `${String(Math.round(share * 100)).padStart(3)}%`
  // A percentage window (Anthropic) already says everything in its bar; a
  // counted one (z.ai credits) is worth spelling out, because "how many left"
  // is the number a user acts on.
  const amount =
    window.unit === '%'
      ? ''
      : `  ${grouped(Math.round(window.used))}/${grouped(Math.round(window.limit))}`
  const reset = window.resetAt === undefined ? '' : muted(`  resets in ${countdown(window.resetAt - now)}`)
  return truncate(`    ${label}  ${bar}  ${pct}${amount}${reset}`, width)
}

/**
 * Draw one provider's plan block: its name and plan, a balance line when it has
 * one, a bar per enforced window, and any notes.
 */
function planBlock(plan: ProviderPlan, now: number, labelWidth: number, width: number): string[] {
  const heading =
    plan.plan === undefined
      ? style(plan.displayName, { bold: true })
      : `${style(plan.displayName, { bold: true })} ${muted(`— ${plan.plan}`)}`
  const out: string[] = [`  ${truncate(heading, width - 2)}`]

  if (plan.problem !== undefined) {
    out.push(`    ${truncate(muted(plan.problem), width - 4)}`)
    return out
  }

  const balance = plan.balance === undefined ? undefined : balanceLine(plan.balance)
  if (balance !== undefined) out.push(truncate(balance, width))

  for (const window of plan.windows) {
    out.push(windowLine(window, now, labelWidth, width))
  }

  for (const note of plan.notes) {
    out.push(truncate(`    ${noteText(note)}`, width))
  }
  return out
}

/** A plan note, colored by its level. */
function noteText(note: ProviderPlan['notes'][number]): string {
  if (note.level === 'warn') return warn(note.text)
  if (note.level === 'ok') return ok(note.text)
  return muted(note.text)
}

/** The balance line: what was granted and topped up, and whether it is usable. */
function balanceLine(balance: NonNullable<ProviderPlan['balance']>): string {
  const split: string[] = []
  if (balance.granted !== undefined && balance.granted > 0) {
    split.push(`${money(balance.granted, '')} granted`)
  }
  if (balance.toppedUp !== undefined && balance.toppedUp > 0) {
    split.push(`${money(balance.toppedUp, '')} topped up`)
  }
  const detail = split.length === 0 ? '' : muted(` (${split.join(' + ')})`)
  const state = balance.available ? ok('available') : warn('unavailable')
  return `    balance ${bold(money(balance.total, balance.currency))}${detail}  ${state}`
}

/**
 * Render the plans-and-limits section.
 *
 * Returns an empty array when there is nothing at all to say, so the caller can
 * leave the heading out entirely rather than print a section that only contains
 * an apology.
 */
export function renderPlans(plans: readonly ProviderPlan[], now: number, width: number): string[] {
  if (plans.length === 0) return []
  const labels = plans.flatMap((plan) => plan.windows.map((window) => displayWidth(window.label)))
  const labelWidth = Math.max(12, ...labels)
  const out: string[] = [bold('Plans & limits')]
  for (const plan of plans) {
    out.push(...planBlock(plan, now, labelWidth, width))
  }
  return out
}
