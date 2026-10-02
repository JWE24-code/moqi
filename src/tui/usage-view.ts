/**
 * `/usage`: what each provider's plan has left, then what this app has spent.
 *
 * The two halves answer two different questions and neither substitutes for the
 * other. The top half is the provider's own account of the plan — a balance, a
 * quota window, when it resets — which only the provider can supply. The bottom
 * half is the local ledger of billed tokens per route, which no provider will
 * break down by conversation the way this app can.
 *
 * Pure like the rest of `tui/`: it draws whatever `usage.ts` and `credits.ts`
 * compute and knows nothing about the Harness, a stream chunk, or the network.
 * `UsageView` is the pane's own state, the same split `FleetView` keeps between
 * its state and `renderFleet`'s pure drawing.
 * @module
 */

import {
  CHART_WIDTH,
  cacheHitRate,
  filledWidth,
  grandTotal,
  grouped,
  promptTotal,
  sortedRows,
  totalUsage,
  type UsageLedger,
} from '../usage.ts'
import { renderPlans, type ProviderPlan } from './credits.ts'
import { displayWidth, padEnd, truncate } from './text.ts'
import {
  bold,
  colAccent,
  colGold,
  colGreen,
  colOK,
  colRose,
  muted,
  style,
  type AdaptiveColor,
} from './theme.ts'

/** The pane's own state: whether it is open, and the data it last drew. */
export class UsageView {
  open = false
  session: UsageLedger = {}
  week: UsageLedger = {}
  lifetime: UsageLedger = {}
  /**
   * Per-provider plan blocks, once they have come back. Empty while the first
   * probe is still out, which is what `plansPending` distinguishes from "asked,
   * and there was nothing to report".
   */
  plans: readonly ProviderPlan[] = []
  /** Whether a plan probe is currently in flight. */
  plansPending = false
  /**
   * The moment this data was computed. A snapshot, like `/jobs` and `/mcp`
   * are — every countdown reads relative to this, not the wall clock at
   * whatever moment a repaint happens to run, so the pane stays internally
   * consistent rather than drifting while it sits open.
   */
  now = 0

  show(): void {
    this.open = true
  }

  hide(): void {
    this.open = false
  }

  /** Install a freshly computed snapshot of the three token windows. */
  setData(session: UsageLedger, week: UsageLedger, lifetime: UsageLedger, now: number): void {
    this.session = session
    this.week = week
    this.lifetime = lifetime
    this.now = now
  }

  /** Note that a plan probe has gone out, so the pane can say so. */
  setPlansPending(): void {
    this.plansPending = true
  }

  /** Install plan blocks as they arrive, ending the pending state. */
  setPlans(plans: readonly ProviderPlan[], now: number): void {
    this.plans = plans
    this.plansPending = false
    this.now = now
  }
}

/** Categorical color cycle for provider identity, assigned in a fixed order and stable across all three sections. */
const SERIES: readonly AdaptiveColor[] = [colAccent, colGreen, colGold, colRose, colOK]

/** One section's heading plus its rows, busiest first within the section. */
function section(
  label: string,
  ledger: UsageLedger,
  order: readonly string[],
  nameWidth: number,
  width: number,
): string[] {
  const out: string[] = [bold(label)]
  const rows = sortedRows(ledger)
  if (rows.length === 0) {
    out.push(muted('  nothing in this window'))
    return out
  }
  const total = grandTotal(totalUsage(ledger))
  for (const [provider, usage] of rows) {
    const sum = grandTotal(usage)
    const share = total > 0 ? sum / total : 0
    const filled = filledWidth(share)
    const color = SERIES[order.indexOf(provider) % SERIES.length] ?? colAccent
    const bar = style('█'.repeat(filled), { fg: color }) + muted('░'.repeat(CHART_WIDTH - filled))
    const name = style(padEnd(truncate(provider, nameWidth), nameWidth), { fg: color })
    const pct = `${String(Math.round(share * 100)).padStart(3)}%`
    // Prompt and output split out, because they are priced differently
    // everywhere and a single total hides which way a route is expensive.
    const split = muted(`↑${grouped(promptTotal(usage))} ↓${grouped(usage.outputTokens)}`)
    const cached = cacheHitRate(usage)
    const cache = cached === undefined || cached === 0 ? '' : muted(` ${String(Math.round(cached * 100))}% cached`)
    const row = `  ${name}  ${bar}  ${pct}  ${grouped(sum)}  ${split}${cache}`
    out.push(truncate(row, width))
  }
  return out
}

/**
 * Render the pane's body. Reads `view.now` rather than the clock, so a
 * countdown renders identically in a test as it does live, and stays
 * consistent with the windows `view.now` was computed alongside.
 */
export function renderUsagePane(view: UsageView, width: number): string[] {
  const out: string[] = [bold('Usage')]

  // ------------------------------------------------ plans, as providers report
  if (view.plansPending && view.plans.length === 0) {
    out.push('', muted('Checking provider plans…'))
  } else if (view.plans.length > 0) {
    out.push('', ...renderPlans(view.plans, view.now, width))
  }

  // ----------------------------------------------- spend, as this app billed it
  const hasTokens =
    Object.keys(view.lifetime).length > 0 ||
    Object.keys(view.session).length > 0 ||
    Object.keys(view.week).length > 0
  out.push('')
  if (!hasTokens) {
    out.push(bold('Token spend'), muted('  nothing recorded yet — tallied once a reply finishes'))
    return out
  }


  // One color per provider, assigned from the lifetime ledger's own busiest-
  // first order — lifetime never forgets a provider a shorter window has
  // rolled off, so it is always the superset the other two draw their colors
  // from, and a provider's color never changes as it ages out of a window.
  const order = sortedRows(view.lifetime).map(([provider]) => provider)
  const nameWidth = Math.max(8, ...order.map((provider) => displayWidth(provider)))

  out.push(...section('Token spend — session (5h)', view.session, order, nameWidth, width), '')
  out.push(...section('Token spend — week (7d)', view.week, order, nameWidth, width), '')
  out.push(...section('Token spend — lifetime', view.lifetime, order, nameWidth, width))

  return out
}
