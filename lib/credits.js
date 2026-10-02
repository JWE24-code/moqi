/**
 * Asking each connected provider what its plan has left.
 *
 * `/usage` used to answer that question from a local token tally, which cannot
 * answer it: a count of what this app sent says nothing about what a plan's
 * 5-hour window has left, what a prepaid balance is down to, or when either
 * resets. Only the provider knows, so this module asks it.
 *
 * Two deliberate seams keep this file honest and testable. Credentials arrive
 * through {@link CredentialLookup} — a structural two-method view of the
 * Harness's credential seam, so no secret is read from a file here and no
 * Harness type is imported; and the HTTP call arrives through {@link FetchLike},
 * so every path in this module can be exercised against recorded responses with
 * no network and no keys. `tui/credits.ts` owns the parsers and the drawing;
 * this module owns only *getting* the bytes.
 *
 * No secret is ever returned, logged, or put in a URL: a token goes into an
 * `Authorization` header and nowhere else, and a failure is reported as the
 * provider's status text, never as the request that produced it.
 * @module moqi-tui/credits
 */
import { anthropicBreakdownNotes, parseAnthropicUsage, parseCodexUsage, parseDeepSeekBalance, parseZaiPlan, parseZaiQuota, } from "./tui/credits.js";
import { deepSeekPeakStatus, looksLikeDeepSeek } from "./usage.js";
import { countdown, money } from "./tui/credits.js";
/** How long any one provider call is given before it is abandoned. */
export const PROBE_TIMEOUT_MS = 8000;
/** A GET returning parsed JSON, or a short reason it did not. */
async function getJson(fetchImpl, url, token, now) {
    const controller = new AbortController();
    const started = now();
    const timer = setTimeout(() => {
        controller.abort();
    }, PROBE_TIMEOUT_MS);
    try {
        const response = await fetchImpl(url, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json',
            },
            signal: controller.signal,
        });
        if (!response.ok) {
            // 401 is the one status worth translating: it is almost always a key that
            // was rotated or a sign-in that lapsed, and "HTTP 401" sends nobody to the
            // right place while "sign-in expired" does.
            return {
                error: response.status === 401 || response.status === 403
                    ? 'sign-in expired or key rejected — re-run /providers'
                    : `provider returned HTTP ${String(response.status)}`,
            };
        }
        return { body: await response.json() };
    }
    catch (error) {
        // An abort is this module's own timeout firing, not a provider fault, and
        // says so; anything else is reported by its message alone.
        if (controller.signal.aborted) {
            return { error: `no answer in ${String(Math.round((now() - started) / 1000))}s` };
        }
        return { error: error instanceof Error ? error.message : 'request failed' };
    }
    finally {
        clearTimeout(timer);
    }
}
// ----------------------------------------------------------------- DeepSeek
/** DeepSeek's balance endpoint. */
export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
/**
 * What DeepSeek's peak window means for someone about to send a long turn.
 *
 * Two separate facts, both worth stating, because they bite differently.
 * Pricing is the predictable one: off-peak is half price, and a countdown to the
 * next flip lets a big job wait for it. Throughput is the one that surprises
 * people — DeepSeek publishes no per-account rate limit and does not reject
 * requests for load; under peak demand it holds the connection open instead, so
 * what a user experiences is not an error but a turn that takes far longer than
 * usual. Saying so is the difference between "DeepSeek is broken" and "it is
 * 09:00 UTC on a Tuesday".
 */
export function deepSeekNotes(now) {
    const status = deepSeekPeakStatus(now);
    const until = countdown(status.changesAt - now);
    if (status.peak) {
        return [
            { level: 'warn', text: `⚠ peak pricing now — off-peak (half price) in ${until}` },
            {
                level: 'info',
                text: 'no request limit is enforced at peak; replies are queued, so turns run slower',
            },
        ];
    }
    return [
        { level: 'ok', text: `✓ off-peak now (half price) — peak resumes in ${until}` },
        { level: 'info', text: 'off-peak is also the faster window: less queueing under load' },
    ];
}
/** DeepSeek: a prepaid balance, plus its peak-window pricing and throughput state. */
async function deepSeekPlan(route, lookup, fetchImpl, now) {
    const base = {
        provider: route.provider,
        displayName: route.displayName,
        windows: [],
        // The peak notes need no credential and no network, so they are useful even
        // when the balance cannot be read — which is exactly when a user is most
        // likely to be looking.
        notes: deepSeekNotes(now()),
    };
    const key = await lookup.resolveKey('DEEPSEEK_API_KEY');
    if (key === undefined) {
        return { ...base, problem: 'no DEEPSEEK_API_KEY stored — balance unavailable' };
    }
    const result = await getJson(fetchImpl, DEEPSEEK_BALANCE_URL, key, now);
    if ('error' in result)
        return { ...base, problem: result.error };
    const balance = parseDeepSeekBalance(result.body);
    if (balance === undefined)
        return { ...base, problem: 'balance response could not be read' };
    return { ...base, balance };
}
// --------------------------------------------------------------------- z.ai
/** z.ai's subscription and quota endpoints. */
export const ZAI_PLAN_URL = 'https://api.z.ai/api/biz/subscription/list';
export const ZAI_QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';
/** z.ai: the GLM coding plan's tier and its rolling credit windows. */
async function zaiPlan(route, lookup, fetchImpl, now) {
    const base = {
        provider: route.provider,
        displayName: route.displayName,
        windows: [],
        notes: [],
    };
    const key = await lookup.resolveKey('ZAI_API_KEY');
    if (key === undefined) {
        return { ...base, problem: 'no ZAI_API_KEY stored — plan unavailable' };
    }
    // Both calls go out together: they are independent, and a pane the user is
    // waiting on should not pay two timeouts end to end.
    const [quotaResult, planResult] = await Promise.all([
        getJson(fetchImpl, ZAI_QUOTA_URL, key, now),
        getJson(fetchImpl, ZAI_PLAN_URL, key, now),
    ]);
    const subscription = 'error' in planResult ? undefined : parseZaiPlan(planResult.body);
    if ('error' in quotaResult) {
        return { ...base, plan: subscription?.plan, problem: quotaResult.error };
    }
    const windows = parseZaiQuota(quotaResult.body);
    const notes = [];
    if (subscription?.renewsAt !== undefined) {
        // Price and cycle ride along when the response states them: "renews in 64d"
        // is a reminder, where "renews in 64d — 43.2 quarterly" is a decision.
        let price = '';
        if (subscription.renewPrice !== undefined) {
            const cycle = subscription.billingCycle === undefined ? '' : ` ${subscription.billingCycle}`;
            price = ` — ${money(subscription.renewPrice, '')}${cycle}`;
        }
        notes.push({ level: 'info', text: `renews in ${countdown(subscription.renewsAt - now())}${price}` });
    }
    return {
        ...base,
        plan: subscription?.plan,
        windows,
        notes,
        problem: windows.length === 0 ? 'no credit windows reported' : undefined,
    };
}
// ---------------------------------------------------------------- Anthropic
/**
 * Anthropic's OAuth usage report — the same figures Claude Code's own `/usage`
 * shows for a Pro/Max plan.
 *
 * Unlike the two key-based routes above, this one has no published contract this
 * app can rest on: it is the endpoint the first-party client uses, reached with
 * the stored sign-in rather than an API key. That is why the parser refuses
 * rather than improvises, and why a shape it does not recognize surfaces as
 * "could not be read" instead of a confident zero.
 */
export const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** Anthropic: the Claude plan's 5-hour session and 7-day week utilization. */
async function anthropicPlan(route, lookup, fetchImpl, now) {
    const base = {
        provider: route.provider,
        displayName: route.displayName,
        windows: [],
        notes: [],
    };
    const token = await lookup.readGrantToken('llm-pi-ai', route.provider);
    if (token === undefined) {
        return { ...base, problem: 'not signed in — run /providers to connect a Claude plan' };
    }
    const result = await getJson(fetchImpl, ANTHROPIC_USAGE_URL, token, now);
    if ('error' in result)
        return { ...base, problem: result.error };
    const windows = parseAnthropicUsage(result.body);
    if (windows.length === 0) {
        return { ...base, problem: 'plan limits response could not be read' };
    }
    // The breakdown is a separate fact from the windows and must not gate them:
    // a response whose breakdown is missing or unparseable still showed its
    // limits, so the note is added only when it says something.
    return { ...base, windows, notes: [...anthropicNotes(windows), ...anthropicBreakdownNotes(result.body)] };
}
/**
 * A word of warning when a Claude plan window is nearly spent. The 7-day window
 * is the one worth flagging loudly: a spent session window costs a few hours,
 * where a spent week costs days.
 */
export function anthropicNotes(windows) {
    const notes = [];
    for (const window of windows) {
        const share = window.limit > 0 ? window.used / window.limit : 0;
        if (share < 0.9)
            continue;
        notes.push({
            level: 'warn',
            text: window.resetAt === undefined
                ? `⚠ ${window.label} nearly spent`
                : `⚠ ${window.label} nearly spent — resets in ${countdown(window.resetAt - Date.now())}`,
        });
    }
    return notes;
}
// -------------------------------------------------------------------- Codex
/**
 * The ChatGPT/Codex usage report — the same figures the Codex CLI's own status
 * line shows for a Plus/Pro plan.
 *
 * Like Anthropic's, this endpoint has no published contract: it is what the
 * first-party client reads, reverse-engineered independently by more than one
 * third-party tracker, and it has already moved once (its figures used to ride
 * on `x-codex-*` response headers). Reached with the stored sign-in rather
 * than an API key, and parsed by a sibling parser that refuses rather than
 * improvises for the same reason as the Anthropic one.
 */
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
/** Codex: the ChatGPT plan's 5-hour and weekly utilization, plus any credits. */
async function codexPlan(route, lookup, fetchImpl, now) {
    const base = {
        provider: route.provider,
        displayName: route.displayName,
        windows: [],
        notes: [],
    };
    const token = await lookup.readGrantToken('llm-pi-ai', route.provider);
    if (token === undefined) {
        return { ...base, problem: 'not signed in — run /providers to connect a ChatGPT plan' };
    }
    const result = await getJson(fetchImpl, CODEX_USAGE_URL, token, now);
    if ('error' in result)
        return { ...base, problem: result.error };
    const parsed = parseCodexUsage(result.body);
    if (parsed === undefined) {
        return { ...base, problem: 'usage report could not be read' };
    }
    return {
        ...base,
        plan: parsed.plan,
        balance: parsed.balance,
        windows: parsed.windows,
        problem: parsed.windows.length === 0 && parsed.balance === undefined ? 'no rate-limit windows reported' : undefined,
    };
}
// ------------------------------------------------------------------ assembly
/**
 * Which probe, if any, knows how to report on a route.
 *
 * Matching is by route id rather than an exhaustive table, so a route the
 * Harness names slightly differently (`deepseek-chat`, `anthropic-oauth`) still
 * finds its probe, and a route nothing here understands is simply left out
 * rather than shown as broken — `/usage` reports on what it can measure, and
 * says nothing about what it cannot.
 */
function probeFor(provider) {
    const id = provider.toLowerCase();
    if (looksLikeDeepSeek(id))
        return deepSeekPlan;
    if (id.includes('zai') || id.includes('z.ai') || id.includes('glm'))
        return zaiPlan;
    if (id.includes('anthropic') || id.includes('claude'))
        return anthropicPlan;
    if (id.includes('codex') || id.includes('chatgpt') || id.includes('openai'))
        return codexPlan;
    return undefined;
}
/** Whether `/usage` has a plan probe for a route at all. */
export function hasProbe(provider) {
    return probeFor(provider) !== undefined;
}
/**
 * A readable name for a route the adapter did not label.
 *
 * An OAuth-only route is configured as an empty entry — there is no key and no
 * endpoint to name — so the adapter has nothing to report and `listProviders()`
 * hands back the bare route id. `anthropic` as a heading over a Claude plan's
 * limits is needlessly cryptic when the plan it describes has a name everyone
 * knows. A label the adapter *does* supply is always preferred to this.
 */
export function friendlyName(provider, displayName) {
    if (displayName !== provider && displayName !== '')
        return displayName;
    const id = provider.toLowerCase();
    if (id.includes('anthropic') || id.includes('claude'))
        return 'Claude (Pro/Max)';
    if (id.includes('codex'))
        return 'OpenAI Codex (ChatGPT)';
    if (looksLikeDeepSeek(id))
        return 'DeepSeek';
    if (id === 'zai' || id === 'z.ai')
        return 'z.ai (GLM coding plan)';
    return displayName === '' ? provider : displayName;
}
/**
 * Ask every route that has a probe, all at once, and return a block per route.
 *
 * Every probe resolves — none rejects — so one provider being down, unset, or
 * slow costs its own block a line of explanation and leaves the rest of the pane
 * intact. That matters more here than anywhere else in the app: the whole point
 * of the pane is the comparison across providers, and a single failed request
 * must not be able to empty it.
 */
export async function collectPlans(routes, lookup, fetchImpl = globalThis.fetch, now = Date.now) {
    const probes = routes.flatMap((route) => {
        const probe = probeFor(route.provider);
        return probe === undefined
            ? []
            : [
                {
                    route: { ...route, displayName: friendlyName(route.provider, route.displayName) },
                    probe,
                },
            ];
    });
    return await Promise.all(probes.map(async ({ route, probe }) => {
        try {
            return await probe(route, lookup, fetchImpl, now);
        }
        catch (error) {
            return {
                provider: route.provider,
                displayName: route.displayName,
                windows: [],
                notes: [],
                problem: error instanceof Error ? error.message : 'probe failed',
            };
        }
    }));
}
// ---------------------------------------------------------------------- cache
/**
 * How long a plan reading is reused before the providers are asked again.
 *
 * Short enough that a reading a user acts on is at most a minute old, long
 * enough that toggling the pane — open, esc, open again to check a number —
 * does not re-hit every provider each time. The countdown texts inside the
 * cached blocks were computed at probe time and so can lag by this much; the
 * countdowns on the reset lines are not cached, because they are drawn from
 * `resetAt` at render time and stay current.
 */
export const PLAN_CACHE_TTL_MS = 60_000;
/**
 * A brief memory of the last {@link collectPlans} result, so reopening
 * `/usage` twice in a minute answers from the earlier reading instead of
 * re-asking every provider.
 *
 * Pure with an injected clock, so the boundary behaviour is testable. Failures
 * are cached on the same terms as successes: a provider that just refused or
 * timed out should not be hammered because the user re-opened the pane, and a
 * minute is short enough to retry soon anyway. There is deliberately no
 * invalidation hook tied to sign-in: a fresh credential is exactly the case
 * where waiting out a minute is preferable to another probe storm.
 */
export class PlanCache {
    ttl;
    now;
    entry;
    // Explicit assignments rather than parameter properties: the test runner
    // loads this file with type-stripping, which rejects that syntax.
    constructor(ttl = PLAN_CACHE_TTL_MS, now = Date.now) {
        this.ttl = ttl;
        this.now = now;
    }
    /** The cached reading, when one is still fresh enough to show. */
    get() {
        if (this.entry === undefined)
            return undefined;
        return this.now() - this.entry.at < this.ttl ? this.entry.plans : undefined;
    }
    /** Remember a reading from `collectPlans`, stamped now. */
    set(plans) {
        this.entry = { plans, at: this.now() };
    }
}
