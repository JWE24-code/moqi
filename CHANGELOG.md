# Changelog

All notable changes to Moqi are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **A file edit reads as a diff.** With tool calls expanded, a
  `str_replace_editor` call shows a removed row as a red bar and an added row
  as a green one, each with its row number and three rows of context either
  side. The change comes from the call's own arguments, since the tool's
  result is a one-line success message; the numbers and context come from the
  file as read once the call settles; and the bar's text takes whichever
  palette color measures as the more readable against it.
- **Start a session from the Sessions list.** The device group carries a
  `+ Ask the harness in a new session` row; `enter` on it opens a new session,
  the same as `ctrl+n`, and it is never counted as a session itself.
- **`k` closes a session in the Sessions list.** On a row this app owns, `k`
  closes that session, as `/close` does. A session in another process, or on a
  peer, is left alone: there is no per-session control channel, and the only
  lever — the owning process — would end every session it holds.

### Changed

- **Tool calls start collapsed.** Each call keeps its one-row checklist line;
  `ctrl+o` opens the outcome underneath. The choice round-trips either way —
  previously only a collapsed view was stored, so an explicit expansion would
  have been lost across restarts.
- **The fleet is now Sessions.** The cross-device overview is renamed from
  "fleet" to **Sessions**: `ctrl+s`, and `/fleet` is now `/sessions`. The list
  itself is unchanged — local sessions and peers, grouped by device.
- **`/stack` is now `/tiled` (`ctrl+t`).** The stacked view is the tiled view:
  `ctrl+t` toggles it, `alt+arrows` move focus and `alt+shift+arrows` move a
  pane. `ctrl+t` previously toggled reasoner display, which remains available
  as `/thinking`.

### Removed

- **The ctrl+c sessions menu.** The first `ctrl+c` now only arms the two-step
  quit; the Sessions view is the one place every session is listed. The
  redundant open-sessions picker (and its `x`-to-close row action) is gone;
  `ctrl+n` and `/close` still manage tabs.

## [0.4.6] — 2026-10-02

### Added

- **Attention in the stacked view.** A session that raises an approval or
  question hosts its panel inside its own tile, and any tile waiting on you or
  finished-unseen blinks its border (warn for input, ok for done) until focused
  or answered.

## [0.4.5] — 2026-10-02

### Fixed

- **An open picker draws over the stacked view.** `/model`, `/theme`,
  `/resume` and every other picker command opened invisibly: the picker took
  the keys but the stack still painted the tiles over it. An open picker now
  outranks the stack tiling.

## [0.4.4] — 2026-10-02

### Fixed

- **The harness packages are linked before the profile's package-manager
  install.** A failed `pnpm install` used to exit `install-profile` before the
  harness's `@deepseek-ai` packages were linked into the app, leaving a
  freshly updated global install unable to boot at all. Linking now happens
  first, and a failed install says the app may still boot.

## [0.4.3] — 2026-10-02

### Added

- **The stacked view** tiles every open session on screen at once, each pane
  boxed with the focused pane's whole border highlighted.
- **Mouse text selection**: hold the left button, drag, release; and copy a
  transcript turn by clicking it twice.
- **`ctrl+s` switches views** and remembers the last view across restarts.

### Fixed

- The profile installer no longer deletes added plugins.

## [0.4.2]

### Security

- **The profile installer refuses names that could leave the profiles
  directory.** It blocked `/` and `\` but accepted `..`, so a profile name could
  write one level up; it now takes a flat, dotless allowlist plus a
  resolved-path containment check.
- **CI installs and child processes are hardened.** Workflow installs pass
  `--ignore-scripts` (npm is pinned; pnpm and the Harness install keep their
  scripts deliberately), and the dev scripts invoke `/bin/sh` and
  `/usr/bin/env git` by absolute path.

### Changed

- **The Sonar backlog is down to maintainability smells.** Every BUG and
  VULNERABILITY finding is resolved; a dead ternary, a `reduce` with no initial
  value, a redundant `void`, and a control character in the CSI regex are
  corrected, and dead imports and length-index reads are gone.

## [0.4.1]

### Changed

- **`TuiApp`'s state now lives in focused controllers.** The turn lifecycle
  moved to a `TurnRunner`, the open-session strip to `SessionTabs`, transcript
  search to `SearchState`, sign-in to a `LoginFlow`, and usage plus the fleet's
  peer list to `tui/state` and `tui/fleet`; confirmations and picker keys answer
  to their own modules. Sessions are listed through a `session-list` module,
  harness-to-surface adapters live in `tui-adapt`, and desktop bridges in
  `local-platform`. `TuiApp` is reduced to its entry points over those seams,
  and the decision is recorded in `docs/adr/0001-state-owning-controllers.md`.

### Fixed

- **Session logs are decoded through one path.** `readLog` duplicated the zstd
  detect/decompress that `decodeLogBytes` already owned, so the two could
  drift; `readLog` now keeps only the file concerns and delegates the decode, so
  a misnamed log decodes by content rather than failing.
- **An unnamed picker key no longer falls through into enter.** A refactor left
  the picker's default navigation case directly above `case enter` with no
  break, so an arrow key both moved the selection and activated the row it had
  just focused — in `/JevLoop`, arrow keys toggled gates and enter looked inert.
- Removed an unreachable `role` conditional in `textOfRecord`.

### Added

- Characterization tests pinning cross-session log-read limits: text before the
  `maxBytes` cut is found and text after it is not, an over-cap compressed log
  is skipped while truncated plain logs still count as scanned, and scan/skip
  counts hold on a mixed store.
- Repository contract docs: `AGENTS.md`, a seeded `CONTEXT.md` glossary, and the
  whiteboard plus ADR map of the refactored shape.

## [0.4.0]

### Added

- **Panel commands on the `tuiHost` seam.** `ctx.tuiHost.registerPanel()` lets a
  plugin contribute a command panel — rows the host draws, an `enter` action,
  and an optional masked secret prompt — so a feature's UI ships with its
  plugin instead of this app. `moqi-jev-loop` uses it for `/JevLoop` (its API key
  and four gates). Command matching is now case-insensitive, so a panel
  registered as `JevLoop` answers to `/jevloop`.

### Changed

- **`shift+enter` is the composer's carriage return.** Enter still submits;
  `shift+enter` (or `ctrl+j`) inserts a newline, so a draft can span several
  lines. Bracketed paste is enabled, so a multi-line paste is inserted whole
  rather than sending on its first line.
- **The dshfind listing is documented as automatic.** The repository carries
  the `dsh-plugin` topic its marketplace indexes, so the README no longer
  describes a listing step that no release needs.
- **A plugin panel cannot shadow the app's own commands.** The palette and
  `runCommand` now agree: on a name collision a built-in or Harness command
  wins, and a panel answers only to a name both leave free.

### Fixed

- **CSI-u and modifyOtherKeys key reports are decoded.** Terminals such as
  Ghostty and foot report modified keys as `ESC [ 13 ; 2 u` (shift+enter) or
  `ESC [ 27 ; 5 ; 13 ~` (ctrl+enter) rather than a bare control byte; the
  decoder now names those keys instead of dropping them.
- **`ctrl+j` inserts a newline, as documented.** The decoder had folded both
  Return (`\r`) and line feed (`\n`) into `enter`, so the advertised `ctrl+j`
  newline submitted instead. Return and line feed are now distinct.
- **`/resume` lists stored sessions again.** Two defects left the picker
  empty: the query call passed a plain object where the session-query service
  takes an optional `AbortSignal` (`signal?.throwIfAborted()` threw, and the
  failure surfaced as "no earlier sessions found"), and the row mapper read
  `id`/`createdAt` off the top level of rows that carry them nested inside
  `header`, so every row was filtered out. The mapper now reads both shapes,
  and no signal is passed. `/tree` benefits from the same fix.
- **A panel survives a failed action or a cancelled prompt.** Enter on a panel
  row used to close the panel and leave only a status line behind when the
  action threw; the panel now stays open and refreshes.

## [0.3.0]

### Added

- **A first-run setup list.** A fresh install opens with the four questions
  every new user has — interface language, color palette, provider sign-in,
  voice setup — as a list whose rows open the pickers that answer them.
  Closing it records that the machine has seen it; it never returns unasked.
- **Live preview in the pickers.** Moving through `/theme` repaints the whole
  app in the highlighted palette, and `/lang` re-renders the chrome in the
  highlighted language; `esc` restores what was in force and `enter` keeps
  what you landed on. Browsing by arrow key is trying it on.
- **Tab completion for command arguments.** `/theme <par<Tab>` completes a
  palette name (shared prefix first, then the picker), and `/lang <Tab>` does
  the same for languages. Completion and browsing end in the same place.
- **Mouse on by default.** The wheel scrolls the transcript and a click on a
  tab in the session bar switches to it. Text selection needs shift while
  reporting is on (the app's own `alt+c`/`ctrl+y` copy needs nothing);
  `--no-mouse` restores plain-drag selection. Shift+click is deliberately
  passed to the terminal rather than treated as an app click.
- **The bell covers everything you stopped waiting for.** A background job
  that finishes rings with a status line naming it, as does a fleet dispatch
  returning from a peer — not only session turns. Jobs are announced on the
  observed running-to-finished transition, so jobs that were already done
  when the app started stay quiet.

### Fixed

- **The interface language no longer resets on restart.** `lang` was written
  on every save but never read back, so a chosen language lasted exactly as
  long as the process did.

- **`moqi`, the app's own palette, and the new default.** A Chinese ink
  painting, which is where the name comes from (墨气): Deep Ink ground, Xuan
  Paper text, Ink Wash selection and borders, Slate Smoke muted layer, with
  the accents kept in the same vocabulary — cinnabar warning, indigo-wash
  accent, celadon/bamboo/ochre semantics — and a light variant that is the
  same painting on paper. The app now starts on it; anyone with a persisted
  choice keeps theirs, and `rose-pine` remains in the table as the former
  default.
- **Fifteen new color palettes.** `/theme` now offers twenty-one palettes where it
  offered five, spanning the styles the original set did not: pastels
  (Catppuccin), vivid neon (Dracula, Monokai, Synthwave), cool blues
  (Tokyo Night), organic greens (Everforest), editor classics (One, Material,
  Tomorrow), ink wash (Kanagawa), warm neutrals (Ayu), minimal paper, the
  green CRT (Phosphor), and two more accessibility corners alongside `mono` —
  `modus`, a pair built to published WCAG contrast guarantees, and
  `contrast`, saturated hues on a pure base. Published palettes use their own
  light and dark variants as published; where none exists (Dracula, Monokai,
  Nord) a light variant is derived from the palette's hues, as Nord's already
  was. `paper`, `phosphor`, `synthwave`, and `contrast` are this app's own.
- **A plan probe for OpenAI Codex (ChatGPT).** The route has had a sign-in
  since `/providers` landed but reported nothing in `/usage`; it now shows the
  ChatGPT plan's tier, its 5-hour and weekly utilization, and any remaining
  credits. The endpoint has no published contract — it is what the first-party
  Codex client reads, reverse-engineered independently by more than one
  third-party tracker, and it has already moved once from `x-codex-*` response
  headers — so the parser is written to the schema those trackers agree on and
  refuses on any other shape. Its one real trap is handled: Codex states reset
  moments in Unix seconds where every other provider states milliseconds.
- **Provider-stated severity colors the plan bars.** Anthropic's usage report
  states per window how pressed it considers the limit (`normal`, `warning`,
  `critical`), and that word now colors the bar instead of the local percentage
  thresholds — the provider knows where the real cliff sits for the plan and
  model in use, so `critical` at 60% is red there where a percentage rule would
  still call it roomy. An unrecognized or missing severity falls back to the
  local thresholds, which remain in force for providers that report only
  numbers.
- **The Claude block names what the week's allowance went to.** The same
  response carries a per-surface breakdown of the 7-day window (Claude Code
  versus chat versus the rest), shown as a note naming the surfaces that used
  any of it — the fact that turns "the week is nearly spent" into a decision
  about where to spend the rest.
- **Plan readings are cached for a minute.** Closing `/usage` and reopening it
  to re-check a number now answers from the earlier reading instead of
  re-hitting every provider; failures are cached on the same terms, so a
  provider that just refused is not hammered for a re-open. Countdowns on reset
  lines stay current regardless, being drawn from the reset time at render
  time.
- **Per-session color themes.** `/theme` used to set one palette for the whole
  app; it is now per session, the same way the model already is. Switching
  tabs repaints in whichever theme that tab is on, a new session starts from
  the theme of the one it was opened from (then diverges independently), and
  a restored session brings its own theme back — falling back to the current
  default if it named a theme this build no longer ships.
- **Sign in to Claude Pro/Max and ChatGPT/Codex.** `/providers` opens a picker
  over every credential `ctx.authorization` knows how to obtain — a
  human-guided sign-in a plain API key cannot replace. This app adds no
  provider knowledge of its own: it renders whatever flows are registered,
  the same way `/plugins` lists whatever packages compose the profile.
  Mounting `@deepseek-ai/dsh-llm-pi-ai` registers a flow for Anthropic (Claude
  Pro/Max) and OpenAI Codex (ChatGPT Plus/Pro) — the two providers it ships a
  login for — from the moment it mounts. A flow's notices and questions are
  rendered as a panel that owns the keyboard until the attempt settles: a
  message plus a page and code to act on, or a prompt (text, a pasted secret,
  or a choice of accounts) that `enter` answers and `esc` declines. The page
  lands on the clipboard the moment the notice does — not only once `enter`
  asks to open it, since the terminal is not always on the machine whose
  browser can reach it — and `enter` on a bare notice also opens it with the
  platform's own launcher (`xdg-open`/`open`/`start`). A device-code flow's
  page and code stay on screen once its own prompt takes over, rather than
  being replaced by it. Signing in authenticates the route; adding it to
  `/model` is still an ordinary `dsh-llm-pi-ai` config, documented in the
  README.
- **`/usage` reports what each provider's plan actually has left.** A local
  tally of tokens cannot answer that question: only the provider knows what a
  prepaid balance is down to, how much of a 5-hour window is gone, or when
  either resets. The pane now asks, using the credentials already in the
  Harness credential store, and shows a block per route — DeepSeek's prepaid
  balance split into granted and topped up, z.ai's plan tier with its 5-hour
  and weekly credit windows and renewal price, and a Claude Pro/Max plan's
  5-hour and 7-day utilization. Every probe runs concurrently and every one
  resolves: a provider that is unset, down, or slow costs its own block one
  line of explanation and leaves the rest of the pane intact, because the
  comparison across providers is the whole point of it. The pane paints
  immediately with what it already knows and fills the plan half in as answers
  land. Quota bars are colored by how close the window is to its limit, not by
  provider identity — a quota is a status reading, not a category. No secret is
  read from a file, printed, or put in a URL: a token goes into an
  `Authorization` header and nowhere else. The parsers refuse rather than
  improvise, which is load-bearing: z.ai reports a window's *limit* in a field
  called `usage` and its *consumption* in `currentValue`, so the obvious
  reading of that payload would show a plan as fully spent while it was 1%
  used. The z.ai parser matches those names exactly and cross-checks them
  against the row's own `remaining`, so a future rename surfaces as a refusal
  rather than silently inverting the bars.
- **DeepSeek's peak window now states its throughput cost, not only its
  price.** The two bite differently. Pricing is predictable and countdown-able
  — off-peak is half price, so a long job can wait for it. Throughput is the
  one that surprises people: DeepSeek enforces no per-account request limit and
  does not reject requests for load, it holds the connection open instead, so
  at peak what you experience is not an error but a turn that takes far longer
  than usual. Saying so is the difference between "DeepSeek is broken" and "it
  is 09:00 UTC on a Tuesday".
- **Token spend is reported in the provider's own four billed buckets**, so a
  row splits prompt from output — priced differently everywhere, and one total
  hides which way a route is expensive — and reports the share of its prompt
  served from cache when there is one to report. That last is the one figure
  here you can act on: a rate that collapses is usually a cache that stopped
  being hit.
- **`/usage`** is a full-screen colored dashboard rather than a markdown
  overlay, so it can carry real per-provider color: three rolling-window
  sections (session 5h, week 7d — the shape Anthropic's Claude Pro/Max and
  z.ai's GLM coding plan both rate-limit on — and a lifetime total that never
  forgets), each a bar chart of every provider's share of the tokens spent *in
  that window*, scaled to that window's own total rather than to its busiest
  provider, so two close providers read as two bars close in length rather
  than one exaggerated against the other. A provider keeps the same color in
  every section it appears in. Session and week are computed from a timestamped
  log kept alongside the lifetime ledger, pruned past 7 days on every write.
  `/usage reset` clears both.
- **`x` closes a session from the `/sessions` list** without leaving it, so
  tidying up several open sessions is not a switch-then-`/close`-then-reopen
  loop. The last session still cannot be closed this way, the same guard
  `/close` already enforces.
- **`/fleet` now attaches to a remote session instead of only reading about
  it.** `enter` on a remote row hands the terminal to a real `ssh -t` running
  that device's `tui` profile and resuming the session — the same keys, the
  same screen, as if it were local — and returns to the overview, repainted,
  once that session ends. Falls back to the previous copy-the-command
  behavior when this process is not attached to a real terminal on both
  ends, since there is then nothing to hand over.

### Fixed

- **`/usage`'s token figures were measuring the wrong quantity entirely.** The
  ledger subtracted one *context size* from another and recorded the difference
  as spend. Context pressure — the size of the prompt the next request would
  send, which is what the footer's `↑`/`↓` pair shows — is not cumulative, so
  that subtraction could not be right. A turn whose context had shrunk since
  the previous one produced a negative difference, clamped to zero, and
  recorded a full prompt's worth of real spend as nothing at all; observed
  live, a second turn billed ~8,300 prompt tokens while the old arithmetic
  computed `7,000 - 8,302` and logged zero. A multi-request turn fared no
  better: only the last request's output was ever counted. The ledger now reads
  the Harness's own `tokenUsage` session projection — four separately-priced
  billed buckets, already retry-aware, so a retried attempt counts as the
  second billed attempt it is — and differences two readings of a quantity that
  really is cumulative. Every failure mode (a projection not mounted, a session
  not yet adopted, a shape this app does not recognize) records nothing rather
  than a confident zero, and the unrecorded spend is not lost: it lands the
  next time a reading succeeds. The persisted state version is bumped, which
  discards the old figures rather than carrying them forward under names that
  would imply they had ever been right.
- **A Claude plan's limits read as `anthropic`.** An OAuth-only route is
  configured as an empty entry, so the adapter has nothing to label it with and
  hands back the bare route id. `/usage` now supplies a readable name for the
  routes it knows — a label the adapter does supply still wins.
- **Attaching to a remote fleet session could look like the whole app
  restarting.** Handing the terminal to `ssh -t` running a second, nested copy
  of this same app surfaced two real bugs on the way back: a stray `SIGHUP` —
  a known hazard of a child taking over a tty — was read as the terminal
  itself hanging up and closed the app outright, and the screen's diff cache,
  left stale by the handover, made the next paint skip lines it believed were
  unchanged, coming back to a screen with nothing on it but the new status
  line. Both are fixed at the one seam every terminal handover already goes
  through, so `alt+e`'s `$VISUAL`/`$EDITOR` round trip is hardened by the same
  fix, caught live when a broken `$EDITOR` reproduced the second bug on the
  first try.
- **A completed browser sign-in could vanish instead of committing the
  credential.** A flow racing a typed code against its own browser callback
  withdraws the losing prompt through that prompt's own `signal` — the
  callback winning is the ordinary case, not a refusal — and this app's
  `prompt()` implementation rejected that withdrawal with
  `AuthorizationDeclinedError`, the class reserved for a human explicitly
  saying no. A flow that reads that rejection at face value discards the
  credential it just obtained through the browser instead of finishing the
  commit, which is what "the website said successful, but nothing came back"
  looked like from here. The signal-abort path now rejects with a plain
  error instead; only `esc` on a live prompt still raises the decline.
- **A failed `/fleet` attach gave no way to see why.** Whatever the remote
  command printed — a stack trace, "command not found," a session the store
  no longer has — was written straight to the terminal while ssh had it, then
  erased the instant the screen cleared to repaint this app's own frame,
  leaving only a bare exit code in the status line. A non-zero exit now opens
  an overlay with the exact command to run outside this app instead, where
  nothing clears its output away mid-read.
- **A copy could silently fail to reach the terminal inside tmux or GNU
  screen.** The OSC 52 clipboard escape was always written raw, but neither
  multiplexer forwards an embedded escape sequence to the real terminal on
  its own — tmux drops it unless `allow-passthrough` happens to be set, not
  the default before tmux 3.3, and screen only ever relays a DCS string it
  recognizes as its own. The escape is now wrapped in whichever
  multiplexer's own passthrough syntax applies (`Ptmux;` for tmux, with every
  embedded ESC doubled; a chunked bare DCS for screen, whose own strings cap
  at 768 bytes) before it reaches the terminal, live-verified inside a real
  tmux session.

### Changed

- **The `/` command palette caps at 3 visible rows and scrolls**, however
  tall the terminal and however many commands match, so it stays a quick
  lookup rather than growing to fill the screen on every keystroke.
- **`--vim` replaces the `/vim` command.** Modal editing is an editing
  preference set once at launch, not a mid-conversation toggle, so it moved
  to a startup flag alongside `--mouse` and `--no-bell`.
- **`/login` renamed `/providers`.** A noun, matching `/model`, `/theme`, and
  `/plugins` — the command browses and signs in to provider routes, it does
  not itself perform "a login."

### Removed

- **`/about`** — version and connection details are still available through
  the README and `/update`'s own version check; the overlay duplicated
  information the footer and `--version` already carry.

## [0.2.1]

### Fixed

- **`moqi --help` rewrote your profile.** The launcher ran the profile
  installer before it looked at its arguments, so any invocation — including
  one that only asked what the flags were — rewrote `$DSH_HOME/profiles/tui`
  and repointed it at whichever copy of the package was running. Installing the
  published tarball into a scratch prefix and running `moqi --help` against it
  was enough to hijack a working development profile, which is exactly how this
  was found. Arguments are read first now: `--help` and `--version` print and
  exit, touching nothing. `--help` is the launcher's own, rather than dsh's
  help arriving after an unannounced install.

  `tests/launcher-smoke.ts` asserts the absence of the side effect rather than
  the presence of the text, because the text was never the broken part — the
  old launcher printed help too, just after installing.

## [0.2.0]

### Added

- **`npm run setup-voice`** — installs everything push-to-talk needs: a
  recorder and whisper.cpp via the system package manager, and the `base.en`
  weights into `~/.cache/whisper/`. Re-runnable, skips what is already there,
  and `--print-only` shows the plan. The missing-dependency lines in the app
  now name this command instead of leaving the reader to search.
- **Interrupt as redirection** — `/interrupt` stops the streaming reply and
  pushes the queued prompts into the loop, where `esc` keeps its old meaning
  of silence (the queue freezes until sent again). The status line after a
  plain interrupt now names both exits, and the queue's drain decision is a
  tested pure function.
- **Tool calls that say what they do** — an expanded tool call shows its
  arguments as one readable line (the command for `bash`, the path for edits,
  the query for searches, the first argument otherwise), and the line appears
  live while the arguments stream, not only after the call settles. The
  in-flight spinner line and a lone settled call show it too. A call's
  outcome now rides in the transcript flow: `tool/result` events from the
  session log settle each row — ✓, ✗, and a one-line result or error under
  the very call that produced it — instead of leaving feedback detached from
  whatever it answers.
- **Session renaming** — `/rename <title>` pins a name onto the active
  session in the Harness's own durable log (a `session/title` event with the
  `user` source), so the tab bar, the resume picker, and any other dsh client
  of the same session all agree. `/rename` with no argument regenerates the
  automatic title — the documented unpin. Text folds to one line and is capped
  at the tab-label budget, the tab and the restore cache update immediately,
  and a profile without the title service says so instead of failing.
- **Plugin management** — `/plugins` lists the packages the active profile
  composes: enabled ones first in composition order and marked with a dot,
  disabled dependencies underneath. `enter` moves a package in or out of
  `dsh.profile.bundles` — a change that applies on the next launch, and the
  status line says so. `/plugins add <pkg>` and `/plugins remove <pkg>` run
  pnpm behind a confirmation (an install runs the package's scripts as you),
  and the base bundle and this app itself are protected from toggling. A
  removal edits the layer stack before uninstalling, so an interrupted run
  leaves a profile that still boots.
- **Voice control** — `ctrl+v` push-to-talk dictation, transcribed locally by
  whisper.cpp and dropped into the composer for review rather than auto-sent.
  Weights and executable resolve from `--voice-model` / `--voice-bin`, then
  `MOQI_WHISPER_MODEL` / `MOQI_WHISPER_BIN`, then a PATH search; when
  nothing is found the app reports it once and carries on exactly as if voice
  did not exist. No audio leaves the machine.

- **Selectable color palettes** — `/theme` opens a picker over `rose-pine`
  (the default, unchanged), `gruvbox`, `nord`, `solarized`, and `mono`;
  `/theme <name>` switches straight away. Each palette ships both a light and
  a dark variant, so `MOQI_THEME=light|dark` still picks the variant and
  `NO_COLOR` still turns color off entirely. `mono` is greyscale and high
  contrast for anyone the hue-based palettes fail. The choice is saved to
  `$DSH_HOME/tui-state.json` and restored before the first frame.
- **Session caching** — the sessions you had open come back after a restart,
  with their transcripts, their per-tab models, and the tab you were looking
  at. Only the ids are stored (in `$DSH_HOME/tui-state.json`, bumped to
  version 2); every transcript is re-read from the Harness's own session
  store, so nothing is duplicated and nothing goes stale. An id the store no
  longer holds is skipped silently — `/delete` and anything else touching
  `$DSH_HOME` can prune it between runs — and a restore that brings back
  nothing falls through to a fresh session, so the app always starts usable.
  `--resume <id>` still wins, and `--no-restore` opts out.

- **Fleet overview** — `ctrl+f` or `/fleet` lists every dsh session across every
  device in one place, grouped by machine and ranked by urgency, with a live
  status mark and the age of each heartbeat. Each device publishes one small
  JSON record per open session under `$DSH_HOME/tui-presence/` and peers are
  read over SSH (`--peer <host>`, repeatable), so nothing new listens on a port
  and no credential is added. `enter` opens a session this app owns and copies
  the `ssh … --resume` command for anything it does not; records are deleted on
  exit so a closed device does not linger as stale.

- **Message queueing** — enter while a reply streams queues the prompt instead
  of rejecting it: queued prompts render as dimmed user turns under the
  streaming block, send themselves in order when the turn finishes without an
  interrupt (per session, tab-switch safe), and `/unqueue` discards them.
- **Pty integration harness** — `npm run test:pty` drives the real `Screen`,
  key decoder, and frame renderer through an actual pseudo-terminal with
  scripted keystrokes: raw mode, the alternate screen, split escape sequences,
  and the two-step ctrl+c are now proven by a round trip. Runs in CI; skips
  itself where util-linux `script(1)` is absent.
- **Composer input history** — press `↑` / `↓` on the composer's outer rows to
  recall previously sent prompts, shell-style, with the in-progress draft
  restored on the way back down.
- **Transcript search** — `/find <text>` searches the whole conversation;
  `n` / `N` (on an empty composer) jump between matches, `esc` clears. Matches
  scroll into view centered, with a `match i/n` counter in the status bar.
- **Copy to clipboard** — `/copy` or `ctrl+y` yanks the last reply over the
  OSC 52 escape, so it works in a plain terminal, over SSH, and inside tmux
  with no external dependency. Long answers are truncated to the terminal's
  usual payload ceiling.
- **Persistence** — sent prompts and the thinking preference now survive a
  restart, stored at `$DSH_HOME/tui-state.json` (atomic write, best-effort).
- **`--version`** flag and a **`/about`** command reporting version, profile,
  host, and the model in use.
- **`?` help hint** — pressing `?` on an empty composer opens the key
  reference, matching the footer hint.
- **CI** — a GitHub Actions workflow runs the dependency-free render smoke
  suite on every push and pull request.
- **LICENSE** — the MIT grant now exists as a real `LICENSE` file rather than
  a README line, so GitHub reports the license and the grant is enforceable.
- **Stream-projection test** — the chunk→transcript switch moved out of
  `index.ts` into a dependency-free `src/tui/stream.ts`, and
  `tests/stream-smoke.ts` replays a synthetic reply (reasoning, text, a
  two-delta tool call, a settled block, usage, and unknown frames) against it,
  closing the last unproven path — the live-reply projection — at the logic
  level.
- **CI typecheck job** — a second workflow job installs `@deepseek-ai/dsh`,
  links its types, and runs `typecheck`, so the Harness-typed files
  (`src/index.ts`, `src/startup.ts`) are compiled against the real packages on
  every push instead of only locally.
- **`test:pty` folded into `npm test`** — the pty round trip now runs as part
  of the default suite (it skips itself where `script(1)` is absent), so local
  and CI runs no longer diverge.
- **`/delete`** — remove a stored session from disk for good, with a yes/no
  confirmation drawn in the composer. Mirrors the JSONL store's path encoding
  so the right directory is removed, and sessions open in a tab are excluded
  from the picker.
- **`/export`** — write the active transcript to a markdown file (defaulting to
  `dsh-transcript-<timestamp>.md` in the session's working directory), with
  user turns quoted, reasoning folded into a `<details>` block, and tool
  activity summarised as a checklist.

### Changed

- **Readline-consistent composer chords** — `ctrl+u` clears the composer
  line and `ctrl+d` deletes forward, as every shell does, instead of both
  scrolling the transcript away under a draft. Half-page scrolling moved to
  `ctrl+↑`/`ctrl+↓`, beside `shift+↑`/`shift+↓` (one line) and `pgup`/`pgdn`
  (a page). `tab` no longer switches sessions while a draft is being typed;
  cycling needs an empty composer, like `n`/`N` in a search. The picker's
  `ctrl+u` (clear filter) is unchanged.
- **Tool calls are expanded by default** — the transcript lists every tool
  call as it happens, with its detail line, instead of summarizing them
  behind a running counter. `ctrl+o` still collapses the pile into one line
  per turn, and the choice is remembered in `$DSH_HOME/tui-state.json` and
  restored on launch.
- **Two-step `ctrl+c`** — the first press opens the sessions menu instead of
  quitting; a second press within 1.5 seconds exits. A stray ctrl+c no longer
  throws away the whole session.

### Changed

- **The app is now Moqi** — 默契, the unspoken understanding between you and
  your harness. The command is `moqi`, the in-app mark reads `◆ moqi`, and the
  environment variables move from `DSH_TUI_*` to `MOQI_*`. The harness's own
  `DSH_HOME` and `DSH_HOST` are untouched, because they are not ours to rename.

  It publishes as **`moqi-tui`**: npm's similarity filter rejects the bare
  `moqi` as too close to `mobx`, `mri`, `joi` and `poi`. The install name and
  the command are separate things, so the suffix lives in `npm install -g
  moqi-tui` and nowhere a user types afterwards. npm's own suggestion was to
  scope it instead, but the scope it proposed contained a `!` — a character
  package names cannot hold — because it is generated from the account name.

  Both earlier names were already taken on npm by other DeepSeek Harness
  terminals: `dsh-tui-app`, a dormant v0.0.1 stub, and `dsh-tui`, active at
  v0.2.19. A scope would have avoided the technical clash but not the
  confusion — three similarly named terminals for one harness is a
  search-results problem, not a naming one. Moqi is its own name, and the
  description no longer borrows another tool's for its shape: it is not an
  "opencode-style terminal", it is this.

  The GitHub repository keeps its name for now, so existing clone URLs work.

- **A turn now reads in the order it happened.** The transcript held a turn's
  prose as one string and its tool calls as a separate list, then drew every
  call above all the text — so a reply that narrated its way through several
  calls arrived as a block of calls followed by one run of concatenated
  sentences, with nothing to say which call the next sentence was about. Order
  is now part of the model: a turn is a list of `Segment`s (text or call) in
  arrival order, text after a call opens a new segment instead of extending the
  one before it, and the renderer walks that list. Each call is one line where
  it was made; `ctrl+o` adds its outcome under it, and the hint that advertises
  the expansion appears only when there is an outcome to reveal. `/export`
  writes the same order, and `/copy` joins the prose with blank lines so the two
  halves of a narration stay two paragraphs.

### Fixed

- **Copying a turn said it worked and put nothing on the clipboard.** `alt+c`
  (and `/copy`, `ctrl+y`) wrote a well-formed OSC 52 escape and reported
  success, but on Wayland the clipboard stayed untouched: a compositor grants
  clipboard ownership only against an input-focus serial, so the terminal can
  accept the escape and still not own the selection. OSC 52 is still always
  written — it is the only channel that survives SSH and tmux — and the text is
  now also handed to a local helper when one exists (`wl-copy`, `xclip`,
  `xsel`, `pbcopy`), which is what actually lands on a desktop. A missing
  helper is not an error.

- **Every prompt was sent blank.** On the plain `enter` path the composer was
  reset *before* `materializePrompt()` read it, so the draft was collected from
  an already-empty composer: the transcript committed a turn with no text (a
  bare `▌` bar), the tab title stayed `new conversation`, and the model was
  asked nothing at all — answering the empty turn with a generic greeting,
  which read as "the agent ignored me". Introduced when `materializePrompt()`
  arrived with `@file` completion and was slotted in after the existing reset;
  every other send path already had the order right.

  `tests/live-pty.ts` could not catch it: it asserted the marker appeared in
  the pty stream, but the marker was quoted in the prompt, and every typed
  character echoes into that stream — so the check passed before the model had
  answered anything. The marker is now a word the prompt never spells, so it
  can only have come back from the model, which is what proves the prompt
  reached it.

- **`ctrl+o` and `/thinking` did nothing to settled turns.** The render cache
  added with the message-line optimisation keyed on the message and the width
  but not on the two toggles that change a turn's lines, so flipping either one
  re-rendered the live turn and served every earlier turn from the stale cache.
  Both are part of the key now.

- **The render benchmark could not run.** `scripts/` was outside
  `tsconfig.typecheck.json`, so `scripts/bench-render.ts` drifted out of step
  with the transcript model and failed at runtime rather than in the typecheck.
  It is in the typechecked set now.

- **CI is green again: the test suite no longer reaches for the Harness.**
  `tests/tui-host-smoke.ts` imported `src/tui-host.ts`, which imports Cordis,
  so `npm test` could not load it from the bare `npm ci` that CI runs —
  every push had failed since the `tuiHost` seam landed. The seam's plain
  classes moved to `src/tui-host-core.ts`, which the suite imports and
  `src/tui-host.ts` re-exports, so `moqi-tui/tui-host` still
  exports exactly what it did. A development checkout could not reproduce any
  of this, because `npm run link-types` makes the import resolve, so
  `tests/offline-imports-smoke.ts` now walks the import graph of every suite
  and fails on a Harness import wherever it runs.

- **`/resume` now moves the tab's session id.** Adopting an earlier session
  swapped the Agent but left the tab claiming the id it had before, so the
  fleet overview published the wrong session for that tab and `/delete`
  offered the very conversation it had open.

- **Model choice is per session.** Every Agent used to share one selection
  ref, so `/model` in one conversation silently rerouted all the others. Each
  session now owns its ref (plus its footer model label and context budget);
  new sessions inherit the model of the session they were opened from and
  diverge independently.

## [0.1.0] - initial

- Terminal app for DeepSeek Harness: bordered composer, live token counter,
  slash palette, markdown transcript with syntax-highlighted code,
  multi-session tabs, background-agent strip, and a tailnet web UI helper.
