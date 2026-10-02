# Rate, cache, usage, and background jobs

The footer carries what the provider reports: prompt and completion tokens, the
context bar, output tokens per second for the last settled turn, and the share
of the prompt that came from the provider's cache. Each is displayed only when
it is real — an unmeasurable rate or a cache hit on an empty prompt is omitted
rather than faked.

That footer is one turn's own numbers, on the session on screen — it says
nothing about what came before, or what another provider has been spending in
another tab. `/usage` is a full-screen colored dashboard instead, in two halves:
what each provider's plan has left, and what this app has actually spent.

```
 Usage

 Plans & limits
   DeepSeek
     balance 55.88 USD (55.88 topped up)  available
     ✓ off-peak now (half price) — peak resumes in 1d 11h
     off-peak is also the faster window: less queueing under load
   z.ai (GLM coding plan) — GLM Coding Lite
     Session (5h)  ░░░░░░░░░░░░░░░░░░░░░░░░    1%  26/2,000  resets in 3h 45m
     Week (7d)     ███████████████░░░░░░░░░   62%  6,170/10,000  resets in 4d 5h
     renews in 64d 10h — 43.2 quarterly
   Claude (Pro/Max)
     Session (5h)  █████████████████████░░░   89%  resets in 3h 4m
     Week (7d)     ██████░░░░░░░░░░░░░░░░░░   25%  resets in 6d 11h
     week's allowance went to: Claude Code 100%

 Token spend — session (5h)
   zai       ████████████████████████  100%  16,623  ↑16,616 ↓7 8% cached

 Token spend — week (7d)
   zai       ████████████████████████  100%  16,623  ↑16,616 ↓7 8% cached

 Token spend — lifetime
   zai       ████████████████████████  100%  16,623  ↑16,616 ↓7 8% cached

 esc back
```

### Plans and limits, as the provider reports them

A local tally of tokens cannot say what a plan has left. Only the provider knows
what a prepaid balance is down to, how much of a 5-hour window is gone, or when
either resets — so `/usage` asks it, using the credentials already in the
Harness credential store. Nothing is read from a file here and no secret is ever
printed: a token goes into an `Authorization` header and nowhere else.

| Route | What it reports | Read with |
|---|---|---|
| DeepSeek | prepaid balance, granted vs topped up, availability, peak-window state | `DEEPSEEK_API_KEY` |
| z.ai | plan tier, 5-hour and weekly credit windows, renewal date and price | `ZAI_API_KEY` |
| Claude (Pro/Max) | 5-hour session and 7-day week utilization, the provider's own severity per window, which surface spent the week | the sign-in `/providers` stored |
| OpenAI Codex (ChatGPT) | plan tier, 5-hour and weekly utilization, remaining credits | the sign-in `/providers` stored |

Every probe runs concurrently and every one of them resolves: a provider that is
unset, down, or slow costs its own block a line of explanation and leaves the
rest of the pane intact, because the comparison across providers is the whole
point of it. The pane paints immediately with what it already knows and fills in
the plan half as answers land. A reading less than a minute old is reused, so
closing the pane and reopening it to re-check a number answers from memory
instead of re-hitting every provider.

When a provider states how pressed a window is in its own words, that word
colors the bar. Anthropic's usage report carries a `severity` per limit —
`normal`, `warning`, `critical` — and it wins over the local percentage
thresholds used for providers that only report numbers, because the provider
knows where the real cliff sits for the plan and model in use; `critical` at 60%
is red there where a percentage rule would still call it roomy. Anthropic's
report also names which surfaces spent the week's allowance — Claude Code
versus chat versus everything else — and the block says so, because "the week
is nearly spent" only becomes a decision when it says what the week went on.

The Codex report is the least contractual of the four: OpenAI publishes no
contract for it, and its figures have already moved once — from `x-codex-*`
response headers to the dedicated path the probe reads now. The parser is
written to the schema independent reverse-engineered trackers agree on, with
its one genuine trap handled: Codex states reset moments in Unix *seconds*,
where every other provider here states milliseconds.

The parsers refuse rather than improvise. A field that is missing or of the wrong
type yields "could not be read", never a zero dressed up as a measurement —
which matters more than it sounds: z.ai reports a window's limit in a field
called `usage` and its consumption in `currentValue`, so the obvious reading of
that payload would show a plan as fully spent while it was 1% used. The z.ai
parser matches those two names exactly and cross-checks them against the row's
own `remaining`, so a future rename surfaces as a refusal instead of silently
inverting the bars.

DeepSeek's own published peak/off-peak schedule — standard pricing 01:00–04:00
and 06:00–10:00 UTC on weekdays, half price every other hour including all of
both weekend days — rides along with its balance, so the pane doubles as a
reminder of whether the clock favors answering now or waiting. Two separate
facts are worth stating, because they bite differently: pricing is predictable
and countdown-able, while throughput is the one that surprises people. DeepSeek
enforces no per-account request limit and does not reject requests for load; at
peak it holds the connection open instead, so what you experience is not an
error but a turn that takes far longer than usual. Chinese public holidays are
also off-peak by DeepSeek's own page but are not modeled here, for want of a
holiday calendar to check against.

### Token spend, as the Harness billed it

The bottom half is every provider this app has actually routed a turn to, in
three rolling windows, kept across a restart the same way the composer history
is. The numbers are the Harness's own **billed** counts, read from its
`tokenUsage` session projection: four separately-priced buckets, already
retry-aware, so a retried attempt counts as the second billed attempt it is.

They are deliberately *not* the footer's `↑`/`↓` pair, which is **context
pressure** — the size of the prompt the next request would send. Conflating the
two is a mistake this app made and has since corrected: it used to subtract one
context size from another and record the difference as spend. That could not be
right, because context pressure is not cumulative. A turn whose context had
shrunk since the last one produced a negative difference, clamped to zero, and
recorded a full prompt's worth of real spend as nothing at all; a turn that
grew the context recorded a number resembling neither. Bumping the persisted
state version discards those old figures rather than carrying them forward under
names that would imply they had ever been right.

**Session (5h)** and **week (7d)** are rolling windows — the same shape
Anthropic's Claude Pro/Max and z.ai's GLM coding plan both rate-limit on —
computed from a timestamped log kept alongside the lifetime ledger, pruned
past 7 days on every write. **Lifetime** never forgets, and its own
busiest-first order is what keeps a provider's color the same in every section
it appears in, even the ones it has aged out of. Each bar is that provider's
share of every token spent *in that window*, not of the busiest provider in
it — two providers within a few points of each other read as two bars close
in length, not one full bar and a shorter one exaggerating the gap.

Each row splits prompt from output, because they are priced differently
everywhere and one total hides which way a route is expensive, and reports the
share of its prompt tokens the provider served from cache when there is one to
report — the one figure here you can act on, since a rate that collapses is
usually a cache that stopped being hit. A turn whose usage could not be read
adds nothing rather than a phantom zero-token row, and its spend is not lost:
it lands the next time a reading succeeds. `/usage reset` clears the ledger and
the rolling-window log alike — there is no undo, the same as `/delete`.

`/jobs` lists what ran or is still running in the background for this session —
state, elapsed time, and the producer's own detail line — with running jobs
first and finished ones newest first. `/jobs kill <id>` stops one. A profile
with no job registry says so instead of showing an empty list.
