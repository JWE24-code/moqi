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
/**
 * The four token buckets every provider reports separately because it prices
 * them separately. Named exactly as the Harness's `tokenUsage` projection
 * names them, so a reader comparing the two sees one vocabulary rather than a
 * translation layer.
 */
export interface TokenBuckets {
    /** Prompt tokens billed at the full input rate — cache reads excluded. */
    uncachedInputTokens: number;
    /** Generated tokens, reasoning included where a provider bills it as output. */
    outputTokens: number;
    /** Prompt tokens served from the provider's cache, billed at a discount. */
    cacheReadTokens: number;
    /** Prompt tokens written into the provider's cache, sometimes billed at a premium. */
    cacheWriteTokens: number;
}
/** Running totals for one provider route. */
export interface ProviderUsage extends TokenBuckets {
    /** Turns that reported usable usage; a turn with none is not counted. */
    turns: number;
}
/** The whole ledger, keyed by provider route id. */
export type UsageLedger = Record<string, ProviderUsage>;
/** A zeroed set of buckets, for folds and for an absent ledger row. */
export declare function noBuckets(): TokenBuckets;
/** Every prompt-side token, however it was billed. */
export declare function promptTotal(buckets: TokenBuckets): number;
/** Every token a route moved, prompt and output together. */
export declare function grandTotal(buckets: TokenBuckets): number;
/** Whether a set of buckets carries nothing at all. */
export declare function isEmptyBuckets(buckets: TokenBuckets): boolean;
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
export declare function bucketDelta(before: TokenBuckets, after: TokenBuckets): TokenBuckets;
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
export declare function recordUsage(ledger: UsageLedger, provider: string, delta: TokenBuckets): UsageLedger;
/** Sum every provider's usage into one row, for a grand-total line. */
export declare function totalUsage(ledger: UsageLedger): ProviderUsage;
/**
 * What share of this route's prompt tokens the provider served from its cache.
 *
 * Worth surfacing because it is the one number in the ledger a user can act
 * on: a high rate means a long conversation is costing a fraction of what its
 * context size suggests, and a rate that collapses is usually a cache that
 * stopped being hit. Returns `undefined` when there were no prompt tokens at
 * all, since "0% of nothing" is a statement about the data, not the cache.
 */
export declare function cacheHitRate(buckets: TokenBuckets): number | undefined;
/** `12345` → `12,345`, so a token count reads at a glance. */
export declare function grouped(value: number): string;
/** Provider rows, busiest (by total tokens) first. */
export declare function sortedRows(ledger: UsageLedger): [string, ProviderUsage][];
/** Bar-chart cells wide at full share; kept modest so an 80-column terminal never has to wrap it. */
export declare const CHART_WIDTH = 24;
/**
 * How many of {@link CHART_WIDTH} cells a share fills, rounded to the nearest
 * whole cell and clamped to the chart's own width either way — a share just
 * shy of 100% still reads as a full bar rather than one cell short of it, and
 * a caller passing a share above 1 cannot paint more cells than the chart is
 * wide.
 */
export declare function filledWidth(share: number): number;
/**
 * One turn's own billed spend, timestamped so it can be folded into a rolling
 * window (the last 5 hours, the last 7 days) rather than only a lifetime
 * total. Kept separate from {@link UsageLedger}'s running totals, which have
 * no timestamp to roll off of and are not meant to: "lifetime" has no window.
 */
export interface UsageEntry extends TokenBuckets {
    provider: string;
    /** Epoch millis the turn settled at. */
    at: number;
}
/**
 * The longest rolling window this app computes. Entries older than this,
 * measured from the newest recorded turn rather than wall-clock "now", are
 * dropped on every write so the log a restart has to replay stays bounded —
 * measuring from the newest entry rather than `Date.now()` keeps a long
 * offline stretch from pruning everything in one write the moment the app
 * reopens.
 */
export declare const WEEK_MS: number;
/**
 * The shorter rolling window: the shape Anthropic's Claude Pro/Max and z.ai's
 * GLM coding plan both rate-limit on, a session that resets every 5 hours.
 */
export declare const SESSION_MS: number;
/**
 * Append one turn to the rolling-window log, pruning anything older than
 * {@link WEEK_MS} from this turn's own timestamp.
 *
 * An empty delta records nothing, the same guard {@link recordUsage} applies
 * and for the same reason — an interrupted turn is not evidence of free usage,
 * it is evidence there is nothing to attribute.
 */
export declare function recordUsageEntry(entries: readonly UsageEntry[], provider: string, delta: TokenBuckets, at: number): UsageEntry[];
/**
 * Fold every entry within `windowMs` of `now` into a ledger shaped exactly
 * like {@link recordUsage} builds, so a caller renders a rolling window with
 * the same functions — {@link sortedRows}, {@link totalUsage} — it renders
 * the lifetime ledger with, rather than a second parallel set for windows.
 */
export declare function windowUsage(entries: readonly UsageEntry[], windowMs: number, now: number): UsageLedger;
/** DeepSeek's current status against its own published peak/off-peak schedule. */
export interface PeakStatus {
    /** Whether standard (peak) pricing is in effect right now. */
    peak: boolean;
    /** Epoch millis of the next transition, peak↔off-peak. */
    changesAt: number;
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
export declare function deepSeekPeakStatus(nowMs: number): PeakStatus;
/** Whether a provider route id looks like it reaches DeepSeek. */
export declare function looksLikeDeepSeek(provider: string): boolean;
/**
 * The app's own usage state: the ledger and the entry log behind `/usage`,
 * persisted across restarts.
 *
 * The fold rules live in the functions above; this class owns the two pieces
 * of state and the few things the app does to them — restore, record, window,
 * clear.
 */
export declare class UsageStore {
    private ledger;
    private entries;
    /** Load what the last run persisted. */
    restore(ledger: UsageLedger, entries: UsageEntry[]): void;
    /** Fold one turn's billed delta, attributed to the provider that answered. */
    record(provider: string, delta: TokenBuckets, at?: number): void;
    /** The ledger as it stands — read-only by convention. */
    view(): UsageLedger;
    /** The entry log as it stands — read-only by convention. */
    entriesView(): UsageEntry[];
    /** Every provider the ledger has already attributed a turn to. */
    providers(): string[];
    /** The rolling session (5h) and week (7d) windows, as of `now`. */
    windows(now: number): {
        session: UsageLedger;
        week: UsageLedger;
    };
    /** `/usage reset`: forget everything. */
    clear(): void;
}
