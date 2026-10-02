# Architecture

Why moqi is a bundle, how it maps onto the Harness, the module layout, the
tests, performance, and the current status and caveats.

## Why a bundle

The shipped `dsh` bundles are `dsh-base`, `dsh-web-app`, `dsh-headless`,
`dsh-sdk-app`, `dsh-sdk-minimal`, and `dsh-acp-app` — there is no terminal app.
The CLI's own README even refers to `dsh --profile tui` as a hypothetical
("assuming the tui profile is installed"). This package is that profile.

It mounts over `dsh-base` with no Host, HTTP server, or browser plugin: the
terminal is the only surface.

## How it maps onto the Harness

| Feature | Service |
|---|---|
| Streaming text, reasoning, tool activity, token usage | `agent/assistant-stream` frames |
| Sending a turn | `agent.followup(createUserMessage(...))` then `agent.whenIdle()` |
| New / resumed sessions | `ctx.agents.create()` / `ctx.agents.resume()` |
| Session list for `/resume` | `ctx.sessionQuery` (optional; the picker degrades if absent) |
| Persistence | `ctx.sessions.flush()` (optional) |
| Slash commands | `ctx.commands` |
| Transcript on resume | the session log, projected from `user/message` and `assistant/message` events |

Optional services are probed rather than injected, so a profile without
persistence or session query still runs — the affected command just reports
that the service is missing.

## Layout

```
src/
  index.ts         the app plugin: Harness wiring, key dispatch, commands
  startup.ts       the cmdline provider (--resume/--model/--thinking/...)
  persist.ts       durable history, preferences, and open sessions under $DSH_HOME
  usage.ts         billed-token ledger, rolling windows, and DeepSeek's peak hours
  credits.ts       asking each provider what its plan has left (credentials + network)
  sessions-store.ts  session storage paths and deletion under $DSH_HOME
  version.ts       reads the package version for --version and /update
  tui/
    screen.ts      raw mode, alternate screen, per-line diffed painting
    keys.ts        escape-sequence decoding, chunk-tolerant
    view.ts        frame composition and layout arithmetic
    state.ts       composer, palette, picker, history, token formatting
    stream.ts      projects assistant-stream chunks onto the transcript
    export.ts      transcript to markdown for /export
    usage-view.ts  the /usage dashboard: plan limits above, token spend below
    credits.ts     provider-response parsers and plan drawing, pure and tested
    osc52.ts       the clipboard escape, wrapped for tmux/screen when one is in the middle
    markdown.ts    markdown to ANSI plus a small syntax highlighter
    text.ts        ANSI-aware width, wrap, truncate
    theme.ts       adaptive palette and SGR styling
    themes.ts      the named palettes /theme chooses between
```

`src/tui/` imports nothing from the Harness and nothing from npm, which is why
it can be tested without a profile. `src/tui-host.ts` is the one module that
does import Cordis, because it *is* the seam (exported as
`moqi-tui/tui-host`); the shortcut registry and status line it
delegates to are plain classes in `src/tui-host-core.ts`, which the suites
import instead, so both are tested without a context — and re-exported from the
seam, so a plugin still needs the one import.

That split is load-bearing rather than tidy: `npm test` runs from a bare
`npm ci`, where `@deepseek-ai/*` does not resolve at all, so a suite that
reaches the Harness cannot even load. `tests/offline-imports-smoke.ts` walks
the import graph of every suite and fails if one does, because a development
checkout has run `npm run link-types` and would otherwise never notice.

## Tests

```sh
npm test        # render, queue, persist, stream, export, sessions, fleet, theme, patch, pty
npm test        # render + queue + persist + stream + pty (370 + 8 + 41 + 20 + 13)
npm run test:pty   # just the pty round trip, for a quick loop (needs script(1))
node --experimental-strip-types tests/preview.ts [normal|palette|picker|stream|think]
```

The smoke test renders real frames at sizes from 20x8 to 200x60 and asserts
the invariants the screen driver depends on: the frame never exceeds the
window, no line exceeds the width, and the cursor always lands inside the
composer. It also exercises the input-history recall and transcript-search
matching; sibling scripts cover queue rendering, the persistence round-trip
against a temporary `$DSH_HOME`, the stream projection (a synthetic model
reply replayed through `tui/stream.ts`), and the color palettes — every theme
is checked for ten well-formed colors in both variants, `/theme` is checked to
actually change the bytes `style()` emits and to restore the default exactly,
and a child process re-runs the suite under `NO_COLOR` to prove it still
suppresses everything. The pty harness drives the real
`Screen`, key decoding, and frame renderer through an actual pseudo-terminal —
raw mode, the alternate screen, split escape sequences, and the two-step
ctrl+c — so the terminal layer is proven by a round trip, not types alone.
`preview.ts` prints a frame so a layout change can be eyeballed. CI runs the
whole suite on Node 22 and 24 plus a typecheck against the real Harness
packages.

## Performance

Rendering is a per-line diff over a zero-dependency renderer, and each settled
transcript turn's lines are cached by identity, width, and the two view toggles
that change them (`ctrl+o` and `/thinking`), so a frame re-renders only what
changed. Measured with `npm run bench` (Node 26, 200x60 window, five segments
per assistant turn):

| Transcript | Before the message cache | Now |
|---|---|---|
| 400 messages | 25.3 ms/frame | **0.20 ms/frame** |

A full scroll or a spinner tick therefore costs a fraction of the 80 ms it has
between paints, which is what makes a long session stay smooth. The benchmark
prints numbers instead of asserting them; the test suite only asserts an
order-of-magnitude bound, so machine noise cannot fail a build while a cache
regression still would.

## Status and caveats

- **Verified against real `dsh` installs** (0.1.5-rc.3 and 0.1.7-rc.2; CI
  typechecks `latest` and `next`):
  - `npm run link-types && npm run typecheck` passes clean against both lines.
  - `dsh --profile tui --dump-config` composes the tree, showing `dsh-base`
    patched by this bundle and both `tui-startup` and `tui-app` mounted.
  - `dsh --profile tui --help` prints this app's own flags, so the startup
    provider parses the real command line.
  - `dsh --profile tui </dev/null` boots the bundle and exits on the non-TTY
    guard.
- **34 suites, 2722 assertions**, covering rendering (including a pty round
  trip through the real screen, decoder, and frame renderer), streaming
  projection, queueing, steering, persistence, the usage ledger and its
  colored dashboard, session storage, cross-session search, the panels
  (including a running sign-in), the plugin seam, i18n, the Sessions view, and the
  render cache.
- **The boot-to-model turn is now automated, on demand.** `npm run test:live`
  (`MOQI_LIVE=1`) boots `dsh --profile tui` under `script(1)`, types a
  prompt, and asserts that the model's answer reaches a painted frame before
  quitting with the two-step ctrl+c. It needs credentials and costs a model
  call, so it is deliberately not part of `npm test`; a manual GitHub workflow
  runs it when a key is configured. The offline pty suite additionally drives
  the real `Screen`, key decoder, and renderer through the `@` menu, an
  approval panel, a questionnaire, and a language switch — which is how a
  space that never matched the panel's toggle was caught.
- **`ctx.sessionQuery` listing is probed.** The service is documented as
  offering "filtered lists" without a stable method name, so `/resume` and
  `/tree` try `listSessions`, `list`, then `querySessions` and report cleanly
  when none exist.
- **Interrupt is best-effort.** `esc` aborts the app's wait and calls
  `interrupt()`/`abort()` on the agent if either exists; whatever streamed is
  still committed.
- **`/mcp` reads, it does not manage.** The MCP client is configured by
  composition, so the pane reports the bridge-prefixed tools that are actually
  mounted and where to declare a server — there is no runtime add/remove.
- **`/providers` knows no provider by name.** It renders whatever `ctx.authorization`
  flows are registered; Claude Pro/Max and ChatGPT/Codex show up once
  `dsh-llm-pi-ai` is mounted, the same as any other OAuth provider it or
  another plugin adds a login for. The service is optional and probed like
  `ctx.sessionQuery`, so a profile without it reports that plainly instead of
  the command doing nothing.
- **Published** to npm as [`moqi-tui`](https://www.npmjs.com/package/moqi-tui).
  The repository carries the [`dsh-plugin`](https://github.com/topics/dsh-plugin)
  topic, which is the whole of the [dshfind](https://dshfind.com) listing
  mechanism: its marketplace indexes public repositories by that topic and
  syncs daily, so there is no listing step to remember per release — a
  repository appears within about a day of the topic being added.
