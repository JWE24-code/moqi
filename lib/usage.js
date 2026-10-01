/**
 * Per-provider token usage, folded in one turn at a time and persisted across
 * restarts so `/usage` answers "how much have I actually used, and where" —
 * a question the per-turn footer counter was never meant to answer, because
 * it shows only the turn on screen and forgets it the moment another begins.
 *
 * The numbers folded in here are the Harness's own **billed** counts, read from
 * its `tokenUsage` session projection: four buckets, priced differently by
 * every provider, and already retry-aware. They are deliberately *not* the
 * footer's `↑`/`↓` pair, which is context pressure — the size of the prompt the
 * next request would send. Those two were conflated in an earlier version of
 * this module, which subtracted one context size from another and called the
 * difference "spend"; the result was a ledger that could not be right, because
 * the quantity it differenced was never cumulative in the first place. A turn
 * that shrinks its own context by compacting genuinely spends tokens, and the
 * old arithmetic recorded that as zero — or, across a switch to a longer
 * conversation, as a spike that never happened.
 *
 * This module is pure: it knows nothing about the Harness, a session, a
 * stream chunk, or ANSI color — `tui/usage-view.ts` draws what this module
 * computes. The call site owns the one fact this module cannot supply — what
 * the provider billed for a just-settled turn, and when — and hands it over as
 * plain numbers.
 * @module moqi-tui/usage
 */
/** Provider key used when a turn settled with no selection to attribute it to. */
const UNKNOWN_PROVIDER = 'unknown';
/** A zeroed set of buckets, for folds and for an absent ledger row. */
export function noBuckets() {
    return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}
/** Every prompt-side token, however it was billed. */
export function promptTotal(buckets) {
    return buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens;
}
/** Every token a route moved, prompt and output together. */
export function grandTotal(buckets) {
    return promptTotal(buckets) + buckets.outputTokens;
}
/** Whether a set of buckets carries nothing at all. */
export function isEmptyBuckets(buckets) {
    return grandTotal(buckets) === 0;
}
/**
 * The exact movement between two readings of one session's cumulative billed
 * usage.
 *
 * The Harness's `tokenUsage` projection folds the whole durable log, so it only
 * ever grows for a given session. Differencing two readings of it therefore
 * yields exactly what the turns in between were billed — which is what makes
 * this subtraction sound where the old context-pressure one was not. A bucket
 * that somehow moved backwards (a log rewritten underneath us, a projection
 * version bump replaying from zero) clamps to zero rather than recording a
 * negative spend.
 */
export function bucketDelta(before, after) {
    return {
        uncachedInputTokens: Math.max(after.uncachedInputTokens - before.uncachedInputTokens, 0),
        outputTokens: Math.max(after.outputTokens - before.outputTokens, 0),
        cacheReadTokens: Math.max(after.cacheReadTokens - before.cacheReadTokens, 0),
        cacheWriteTokens: Math.max(after.cacheWriteTokens - before.cacheWriteTokens, 0),
    };
}
/**
 * Fold one turn's own billed spend into the ledger, keyed by the provider that
 * handled it.
 *
 * An empty delta records nothing: a turn interrupted before its first usage
 * sample, or one the projection could not account for, is not evidence the
 * provider was used for free — it is evidence there is nothing to attribute,
 * and a phantom row with `turns: 1` and `0` tokens would only be confusing in
 * the dashboard.
 */
export function recordUsage(ledger, provider, delta) {
    if (isEmptyBuckets(delta))
        return ledger;
    const key = provider === '' ? UNKNOWN_PROVIDER : provider;
    const previous = ledger[key] ?? { ...noBuckets(), turns: 0 };
    return {
        ...ledger,
        [key]: {
            uncachedInputTokens: previous.uncachedInputTokens + delta.uncachedInputTokens,
            outputTokens: previous.outputTokens + delta.outputTokens,
            cacheReadTokens: previous.cacheReadTokens + delta.cacheReadTokens,
            cacheWriteTokens: previous.cacheWriteTokens + delta.cacheWriteTokens,
            turns: previous.turns + 1,
        },
    };
}
/** Sum every provider's usage into one row, for a grand-total line. */
export function totalUsage(ledger) {
    const total = { ...noBuckets(), turns: 0 };
    for (const row of Object.values(ledger)) {
        total.uncachedInputTokens += row.uncachedInputTokens;
        total.outputTokens += row.outputTokens;
        total.cacheReadTokens += row.cacheReadTokens;
        total.cacheWriteTokens += row.cacheWriteTokens;
        total.turns += row.turns;
    }
    return total;
}
/**
 * What share of this route's prompt tokens the provider served from its cache.
 *
 * Worth surfacing because it is the one number in the ledger a user can act
 * on: a high rate means a long conversation is costing a fraction of what its
 * context size suggests, and a rate that collapses is usually a cache that
 * stopped being hit. Returns `undefined` when there were no prompt tokens at
 * all, since "0% of nothing" is a statement about the data, not the cache.
 */
export function cacheHitRate(buckets) {
    const prompt = promptTotal(buckets);
    if (prompt === 0)
        return undefined;
    return buckets.cacheReadTokens / prompt;
}
/** `12345` → `12,345`, so a token count reads at a glance. */
export function grouped(value) {
    return value.toLocaleString('en-US');
}
/** Provider rows, busiest (by total tokens) first. */
export function sortedRows(ledger) {
    return Object.entries(ledger).sort(([, a], [, b]) => grandTotal(b) - grandTotal(a));
}
/** Bar-chart cells wide at full share; kept modest so an 80-column terminal never has to wrap it. */
export const CHART_WIDTH = 24;
/**
 * How many of {@link CHART_WIDTH} cells a share fills, rounded to the nearest
 * whole cell and clamped to the chart's own width either way — a share just
 * shy of 100% still reads as a full bar rather than one cell short of it, and
 * a caller passing a share above 1 cannot paint more cells than the chart is
 * wide.
 */
export function filledWidth(share) {
    return Math.round(Math.max(Math.min(share, 1), 0) * CHART_WIDTH);
}
/**
 * The longest rolling window this app computes. Entries older than this,
 * measured from the newest recorded turn rather than wall-clock "now", are
 * dropped on every write so the log a restart has to replay stays bounded —
 * measuring from the newest entry rather than `Date.now()` keeps a long
 * offline stretch from pruning everything in one write the moment the app
 * reopens.
 */
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * The shorter rolling window: the shape Anthropic's Claude Pro/Max and z.ai's
 * GLM coding plan both rate-limit on, a session that resets every 5 hours.
 */
export const SESSION_MS = 5 * 60 * 60 * 1000;
/**
 * Append one turn to the rolling-window log, pruning anything older than
 * {@link WEEK_MS} from this turn's own timestamp.
 *
 * An empty delta records nothing, the same guard {@link recordUsage} applies
 * and for the same reason — an interrupted turn is not evidence of free usage,
 * it is evidence there is nothing to attribute.
 */
export function recordUsageEntry(entries, provider, delta, at) {
    const kept = entries.filter((entry) => entry.at > at - WEEK_MS);
    if (isEmptyBuckets(delta))
        return kept;
    const key = provider === '' ? UNKNOWN_PROVIDER : provider;
    return [...kept, { provider: key, ...delta, at }];
}
/**
 * Fold every entry within `windowMs` of `now` into a ledger shaped exactly
 * like {@link recordUsage} builds, so a caller renders a rolling window with
 * the same functions — {@link sortedRows}, {@link totalUsage} — it renders
 * the lifetime ledger with, rather than a second parallel set for windows.
 */
export function windowUsage(entries, windowMs, now) {
    let ledger = {};
    for (const entry of entries) {
        if (entry.at <= now - windowMs)
            continue;
        ledger = recordUsage(ledger, entry.provider, entry);
    }
    return ledger;
}
/** [startHour, endHour) in UTC, each a peak window on a weekday. */
const DEEPSEEK_PEAK_HOURS_UTC = [
    [1, 4],
    [6, 10],
];
/**
 * Whether a moment falls in one of DeepSeek's published peak windows:
 * 01:00–04:00 and 06:00–10:00 UTC, Monday through Friday. Everything else —
 * nights, evenings, and all of both weekend days — is off-peak, at half the
 * peak price. Chinese public holidays are also off-peak by DeepSeek's own
 * pricing page, but are not modeled here: there is no holiday calendar to
 * check against, so a holiday reads as an ordinary weekday.
 */
function isDeepSeekPeakHour(date) {
    const day = date.getUTCDay(); // 0 Sunday .. 6 Saturday
    if (day === 0 || day === 6)
        return false;
    const hour = date.getUTCHours();
    return DEEPSEEK_PEAK_HOURS_UTC.some(([start, end]) => hour >= start && hour < end);
}
/**
 * DeepSeek's peak/off-peak status at `nowMs`, and when it next flips.
 *
 * The schedule only ever changes on an hour boundary, so the search snaps to
 * the start of the next hour and steps forward one hour at a time — exact,
 * where stepping by fixed offsets from `nowMs` itself would not be, since
 * `nowMs` is rarely already on the hour. A full 8-day walk is generous
 * headroom for the longest possible off-peak stretch the schedule allows (a
 * Friday's last peak window ending, straight through the weekend, to Monday
 * 01:00 — under 64 hours) and returns rather than throws if that headroom is
 * somehow not enough, so a schedule bug degrades to a wrong countdown, never
 * a crash.
 */
export function deepSeekPeakStatus(nowMs) {
    const now = new Date(nowMs);
    const peak = isDeepSeekPeakHour(now);
    let t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() + 1, 0, 0, 0);
    for (let i = 0; i < 24 * 8; i += 1) {
        if (isDeepSeekPeakHour(new Date(t)) !== peak)
            return { peak, changesAt: t };
        t += 60 * 60 * 1000;
    }
    return { peak, changesAt: t };
}
/** Whether a provider route id looks like it reaches DeepSeek. */
export function looksLikeDeepSeek(provider) {
    return provider.toLowerCase().includes('deepseek');
}
/**
 * The app's own usage state: the ledger and the entry log behind `/usage`,
 * persisted across restarts.
 *
 * The fold rules live in the functions above; this class owns the two pieces
 * of state and the few things the app does to them — restore, record, window,
 * clear.
 */
export class UsageStore {
    ledger = {};
    entries = [];
    /** Load what the last run persisted. */
    restore(ledger, entries) {
        this.ledger = ledger;
        this.entries = entries;
    }
    /** Fold one turn's billed delta, attributed to the provider that answered. */
    record(provider, delta, at = Date.now()) {
        this.ledger = recordUsage(this.ledger, provider, delta);
        this.entries = recordUsageEntry(this.entries, provider, delta, at);
    }
    /** The ledger as it stands — read-only by convention. */
    view() {
        return this.ledger;
    }
    /** The entry log as it stands — read-only by convention. */
    entriesView() {
        return this.entries;
    }
    /** Every provider the ledger has already attributed a turn to. */
    providers() {
        return Object.keys(this.ledger);
    }
    /** The rolling session (5h) and week (7d) windows, as of `now`. */
    windows(now) {
        return {
            session: windowUsage(this.entries, SESSION_MS, now),
            week: windowUsage(this.entries, WEEK_MS, now),
        };
    }
    /** `/usage reset`: forget everything. */
    clear() {
        this.ledger = {};
        this.entries = [];
    }
}
