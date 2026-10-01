# Moqi

*默契 — the unspoken understanding between you and your harness.*

A terminal app for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
packaged as a Harness bundle. It is the rebuild of an earlier standalone Go
client, reimplemented as a first-class `dsh` profile so it drives the real
Harness agent instead of a private HTTP API.

The name is the point of the thing: a good terminal agent is one you stop
having to explain yourself to. Moqi keeps the conversation in the order it
happened, puts each tool call where it was made, and gets out of the way.

```
 ◆ moqi  tail docker logs                                              local harness

 ▌ how do i tail the last 50 lines of a container log?

 ✓ shell  docker ps

 Use  docker logs  with  --tail  and  -f :

   sh
   │ docker logs --tail 50 -f webui

 •  --since 10m  — only the last ten minutes
 •  -t  — prefix each line with a timestamp

 ╭──────────────────────────────────────────────────────────────────────────────╮
 │ Ask the harness…  (/ for commands)                                           │
 ╰──────────────────────────────────────────────────────────────────────────────╯
 deepseek-chat  ·  ctx 1.5K/65K 2%  ·  ↑1.2K ↓312          / commands  ·  ctrl+c menu
```

## Why a bundle

The shipped `dsh` bundles are `dsh-base`, `dsh-web-app`, `dsh-headless`,
`dsh-sdk-app`, `dsh-sdk-minimal`, and `dsh-acp-app` — there is no terminal app.
The CLI's own README even refers to `dsh --profile tui` as a hypothetical
("assuming the tui profile is installed"). This package is that profile.

It mounts over `dsh-base` with no Host, HTTP server, or browser plugin: the
terminal is the only surface.

## Install

Requires a working `dsh` on `PATH` (`npm install -g @deepseek-ai/dsh`) and
Node 22+.

From npm — one command, then the launcher installs the profile and hands the
terminal to dsh:

```sh
npm install -g moqi-tui
moqi
```

`moqi install` only refreshes the profile, and
`dsh plugin --profile tui add moqi-tui` works too. `/update`
inside the app checks npm and upgrades the global install.

The installer also links the installed Harness's own `@deepseek-ai` packages
into the app. This is not optional bookkeeping: the profile links the app from
wherever it was installed, so Node resolves the app's imports from the app's
own directory, where those packages do not otherwise exist — and the app would
crash on boot with `ERR_MODULE_NOT_FOUND`. Linking the harness's copies (rather
than installing a second set) also guarantees exactly one `@deepseek-ai/cordis`,
because two copies would be two different `Service` classes.

From source — clone, build, and link the profile to the checkout:

```sh
git clone https://github.com/JWE24-code/moqi ~/Projects/moqi
cd ~/Projects/moqi
npm install
npm run build              # emits lib/
npm run install-profile    # creates $DSH_HOME/profiles/tui and links this checkout
dsh --profile tui
```

`install-profile` writes the profile directory itself rather than copying a
template, because the profile's dependency on this package has to be an
absolute path to wherever the repository actually lives. It creates:

```
$DSH_HOME/profiles/tui/         # $DSH_HOME defaults to ~/.dsh
  package.json                  # dsh.profile.bundles + a link: to this checkout
  cordis.patch.yml              # your own patch layer, composed last
  pnpm-workspace.yaml           # nodeLinker: hoisted, autoInstallPeers: false
```

with the bundle order the profile composes:

```json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "moqi-tui"] } }
```

Pass a name to install under a different profile: `npm run install-profile -- chat`.

### Typechecking against your installed Harness

The `@deepseek-ai/*` imports are optional peers: the Harness resolves them from
its own installation anchor at runtime, so they are deliberately not
dependencies here. To typecheck against the exact build you will run under:

```sh
npm run link-types    # symlinks the installed dsh's @deepseek-ai packages
npm run typecheck
```

## Flags

| Flag | Meaning |
|---|---|
| `--resume <id>` | Open a persisted session instead of starting a new one |
| `--model <name>` | Model to select for this run |
| `--thinking` | Start with reasoning output visible |
| `--context-limit <n>` | Override the context budget; the default is the model's own capacity |
| `--mouse` | Report mouse events; the default now, and accepted so an alias that passes it keeps working |
| `--no-mouse` | Disable mouse reporting; the wheel scrolls and the tab bar clicks by default, and shift selects text for the terminal |
| `--no-bell` | Stay silent when a session finishes |
| `--vim` | Modal vim editing in the composer: `esc` for normal mode, `i` to insert |
| `--peer <host>` | Device to include in the fleet overview; repeatable |
| `--no-restore` | Start with one empty session instead of reopening the last ones |
| `--version` | Print the app version |

`MOQI_CONTEXT_LIMIT` sets the same budget; `MOQI_THEME=light\|dark`
overrides background detection; `NO_COLOR` disables styling.

## Keys

| Key | Action |
|---|---|
| `enter` | Send · steers into a running reply · a menu on top chooses with `enter` too |
| `shift+enter` | Insert a newline · `ctrl+j` does the same · multi-line pastes land whole |
| `↑` / `↓` | On the first / last composer row, recall earlier prompts |
| `/` | Command palette, 3 rows at a time and scrolling past that · `tab` accepts · `esc` dismisses |
| `@` | File completion over the workspace · `tab`/`enter` accepts · `esc` dismisses |
| `?` | Open the key reference on an empty composer |
| `esc` | Interrupt a streaming reply |
| `esc` (alone) | Recognized after a 50 ms grace, so a lone press is never mistaken for a sequence's first byte |
| `alt+e` | Edit the draft in `$VISUAL`/`$EDITOR` · non-zero exit keeps it |
| `alt+↑`/`alt+↓` | Select a transcript turn (gold bar) · `esc` clears |
| `alt+c` | Copy the selected turn over OSC 52 |
| `tab` | While a reply streams: queue the prompt for after it |
| `ctrl+enter` | Interrupt the reply and send now (needs a terminal that reports it) |
| `ctrl+n` / `ctrl+r` / `ctrl+t` | New session · resume · toggle thinking |
| `pgup`/`pgdn` | Scroll a page · `ctrl+↑`/`ctrl+↓` half a page |
| `shift+↑`/`shift+↓` | Scroll one line · `ctrl+g` jumps back to the newest |
| `ctrl+o` | Show or hide each tool call's outcome, under the call itself |
| `ctrl+x` | Compact the session |
| `ctrl+b` | Expand or collapse the background-agent strip |
| `ctrl+y` | Copy the last reply to the clipboard |
| `ctrl+f` | Fleet overview: sessions across every device |
| `n` / `N` | With a search open and an empty composer, next / previous match |
| `alt+1`…`alt+9` | Jump to a session · `alt+n`/`alt+p` cycle · `tab` cycles on an empty composer |
| `ctrl+a`/`ctrl+e`/`home`/`end`, `ctrl+w`, `ctrl+k` | Line start/end, delete word, kill to end |
| `ctrl+u` | Clear the composer line (readline) |
| `ctrl+d` | Delete forward · `alt+b`/`alt+f`, `ctrl+←`/`ctrl+→` word motion |
| `ctrl+c` | Sessions menu · press again within 1.5s to quit |

In a list (`/model`, `/theme`, `/resume`): type to filter, `enter` selects, `esc` closes;
`ctrl+n`/`ctrl+p` or the arrows move, `pgup`/`pgdn` move by ten, `home`/`end`
jump, and `ctrl+u` clears the filter.

## Steering, queueing, and interrupting a running reply

A prompt entered while the active session is still replying has three
destinations, one per key:

- **`enter` steers** — the prompt is delivered into the running turn and lands
  at its next step boundary, so the agent changes course mid-answer. Steered
  prompts render dimmed in the transcript so the interleaving reads honestly.
- **`tab` queues** — the prompt waits under the streaming block, dimmed, with
  the footer counting it (`2 queued — sends when the reply finishes`). The
  moment a turn finishes without an interrupt, the next queued prompt sends
  itself, in order, into the same session — even if you have switched tabs in
  between.
- **`ctrl+enter` interrupts and sends** — the running reply stops and the
  prompt goes in immediately (the same thing `/interrupt` does to a queue).

`enter` submits, and `shift+enter` (or `ctrl+j`) is the composer's carriage
return: it makes a newline, so a draft can be several lines. A bracketed paste
is inserted whole, so a multi-line block lands as lines instead of submitting
on its first one.

Interrupting with `esc` keeps the queue; it flushes the next time a turn
completes cleanly, `/interrupt` stops the reply and flushes it now, and
`/unqueue` discards it.

## `@` file completion

Type `@` at the start of a word for a fuzzy picker over the workspace — the
same subsequence filter the model picker uses, shallower paths first. A query
containing `/` (`@src/tu`) lists that one directory instead; picking a
directory descends into it. `enter` or `tab` accepts, `esc` dismisses only the
menu. An `@` in prose (`user@host`) never triggers it.

Picking an image (png/jpeg/webp/gif) stages it as a durable attachment through
the Harness attachment service and inserts an `[Image #N path]` token; on send
the token leaves the text and the image goes along as a content block, with a
`🖼 name WxH` line in the transcript. Without the attachment service the path
is inserted as plain text instead.

## Tool calls, where they happened

An agent turn is a sequence: it says something, runs a tool, says something
about what came back. The transcript is written that way — each call is one line
in the place it was made, between the prose on either side of it:

```
 Let me check what is running.

 ✓ bash  docker ps

 Only webui is up, so its log is the one to read.

 ⠹ bash  docker logs --tail 50 webui  8s
```

The call in flight carries the spinner and its own elapsed time; a settled call
carries `✓`, or `✗` with its error. `ctrl+o` adds each call's outcome
underneath the call that produced it:

```
 ✓ bash  docker ps
   ↳ webui postgres
```

A turn whose calls returned something to show says so once, at the end, rather
than advertising an expansion that would reveal nothing:

```
   ctrl+o for detail
```

This replaced an earlier design that held a turn's prose as one string and its
calls as a separate list, then drew all the calls above all the text. That threw
away the one thing a reader needs — which call the next sentence is about — and
because the prose fragments were concatenated with nothing between them, two
paragraphs from either side of a call arrived as one run of text. Order is now
part of the model (`Segment` in `src/tui/state.ts`), not something the renderer
tries to reconstruct.

## Scrolling

The wheel scrolls the transcript, and a click on a tab in the session bar
switches to it — mouse reporting is **on** by default, because those two are
what most people reaching for a mouse actually want. The cost is real but
small and one-sided: terminals suppress their own text selection while
reporting is on, so selecting text to copy needs shift held (and the app's own
`alt+c` / `ctrl+y` copy needs nothing). Pass `--no-mouse` to put selection back
on plain drag. Scrolling away from the newest output is announced in the
status bar with the way back (`ctrl+g`).

## Searching the transcript

`/find <text>` searches the whole conversation (case-insensitive) and scrolls
the first match into view, with a `match 1/12` counter in the status bar. On
an empty composer, `n` jumps to the next match and `N` to the previous one —
the same letters a pager uses — and `esc` clears the search so `n` types an
`n` again (press `esc` a second time to interrupt a streaming reply; the
cheapest thing open closes first). Matches are recomputed each jump, so a
reply still streaming in simply adds lines to search rather than going stale.

## Copying an answer

`/copy` (or `ctrl+y`) yanks the last reply to the system clipboard, and
`alt+↑`/`alt+↓` then `alt+c` copies any turn you select. Very long answers are
truncated to what the terminal is willing to accept.

Two channels are used, because neither is sufficient alone. The OSC 52 escape
is the one a terminal owns: no dependency, no external process, and it is what
survives SSH, where nothing running locally can reach the clipboard you are
actually looking at. Inside tmux or GNU screen the escape is wrapped in that
multiplexer's own passthrough syntax first — a bare OSC 52 does not reach the
real terminal through either one on its own, since tmux drops it unless
`allow-passthrough` happens to be set and screen only ever relays a DCS string
it recognizes as its own. But a Wayland compositor grants clipboard ownership
only against an input-focus serial, so a terminal can accept a perfectly
well-formed escape and still leave the selection untouched — the copy reports
success and nothing is on the clipboard. So when a local helper is present
(`wl-copy`, `xclip`, `xsel`, `pbcopy`) the text goes there too, and that is the
one that lands on a desktop. A missing helper is not an error; it just leaves
OSC 52 to do the job it is good at.

## Dictating with your voice

```sh
npm run setup-voice
```

Then press `ctrl+v` in the app, speak, and press it again. The transcript is
placed in the composer for you to read and edit — it is never sent for you,
because a misheard prompt that sends itself is worse than no dictation at all.

Everything happens on your machine: audio is recorded by `arecord` or `sox` to
a temporary 16 kHz mono wav and transcribed by a local
[whisper.cpp](https://github.com/ggerganov/whisper.cpp) binary. No audio leaves
the machine and there is no API key. It follows that dictation only works where
the microphone is — over SSH there isn't one.

`setup-voice` is the whole story: it installs a recorder and whisper.cpp with
your system package manager (asking for your password once), downloads the
`base.en` weights to `~/.cache/whisper/`, and re-runs safely, skipping whatever
is already in place. `--print-only` shows what it would do without doing it.
The one platform it cannot finish is Debian and Ubuntu, which package the
Python implementation rather than whisper.cpp; it says so rather than guessing.

These are deliberately not npm dependencies — the executable is native and the
weights are a 140MB download — which is why they are a setup step rather than
part of `npm install`.

To point at your own build or weights, `--voice-bin` and `--voice-model` win,
then `MOQI_WHISPER_BIN` and `MOQI_WHISPER_MODEL`, then a search of PATH
and of `~/.cache/whisper`, `~/.local/share/whisper` and the two
`share/whisper.cpp` directories. `--voice-lang` or `MOQI_WHISPER_LANG` sets
the language; without one, whisper decides.

When a piece is missing the footer names which one and the command that fixes
it, rather than reporting that voice is unavailable.

## What persists

Sent prompts, the thinking preference, and the chosen color palette are saved
to `$DSH_HOME/tui-state.json` (`$DSH_HOME` defaults to `~/.dsh`) and restored on
the next launch. The model choice is saved through the Harness's own
`saveSelection`, not this file. Writing is atomic and best-effort: a read-only
home means the app runs exactly as before, just without recall across
restarts.
Sent prompts, the thinking preference, and the sessions you had open are saved
to `$DSH_HOME/tui-state.json` (`$DSH_HOME` defaults to `~/.dsh`) and restored
on the next launch. The profile-wide model default is saved through the
Harness's own `saveSelection`, not this file; the per-session model a `/model`
switch chose is part of the tab and comes back with it.

Reopening is deliberately timid. Only the session ids are remembered — every
transcript is re-read from the Harness's own session store — and an id that
store no longer holds is skipped without a word, because `/delete` and
anything else that touches `$DSH_HOME` can prune it between two runs. If
nothing at all comes back you get a fresh session, exactly as before. Pass
`--no-restore` to always start clean, and `--resume <id>` to name one session,
which wins over both.

Writing is atomic and best-effort: a read-only home means the app runs exactly
as before, just without recall across restarts.

The `/usage` ledger lives in the same file and survives a restart the same
way, so a provider's running total is a lifetime one, not a per-session one;
see [Rate, cache, usage, and background jobs](#rate-cache-usage-and-background-jobs).

## One list of every device

```sh
dsh --profile tui --peer laptop --peer workstation
```

`ctrl+f` (or `/fleet`) shows every dsh session across every device, grouped by
machine, most urgent first, with a status mark and the age of each heartbeat.

```
 Fleet
 2 running, 1 ready across 2 devices

 workstation  (this device)
  ⠹ rebuild the search index   deepseek-chat                            3s
  · draft the release notes    deepseek-chat                           12m

 laptop
  ● summarise yesterday        glm-4.7                                  8s

 ↑↓ move  ·  enter open  ·  r refresh  ·  esc back            3 sessions
```

Each device writes one small JSON record per open session under
`$DSH_HOME/tui-presence/`, refreshed on a heartbeat and deleted on exit. Peers
are read with a single non-interactive `ssh` command, so **nothing new listens
on a port and no credential is added** — SSH is already the boundary. A record
that stops being refreshed reads as `stale` rather than claiming forever that
it is running.

`enter` switches to the session when this app already owns it. For a remote
one it hands the terminal to a real `ssh -t`, running that device's `tui`
profile and resuming the session — the same keys, the same screen, as if it
were local. Leaving that remote session (its own `/close` or `/exit`, or just
disconnecting) returns you to the fleet overview here, repainted. This needs
this process to actually be attached to a terminal on both ends; short of
that (piped output, a non-interactive run) it falls back to copying the
command instead, the same as it always did.

Handing the terminal to `ssh -t` running a *second, nested copy of this same
app* is more than `$VISUAL` ever asked of it, and it surfaced two real bugs on
the way back: a stray `SIGHUP` — a known hazard of a child taking over a tty —
was read as the terminal itself hanging up and closed the whole app, and a
diff cache left stale by the handover meant the screen came back blank but for
the new status line, since it compared against a frame the actual terminal no
longer had. Both are fixed at the one seam every terminal handover already
goes through, so `alt+e`'s editor round trip is hardened by the same fix:

```sh

```sh
ssh -t laptop 'dsh --profile tui --resume session-…'
```

`p` goes one better for reading without leaving: it fetches the peer's session
log over the same SSH channel and shows the last turns as a read-only preview,
decoded here. Nothing on the peer is written, nothing new listens, and the
path is built with the store's own segment encoder, so a hostile presence
record cannot reach outside its own session directory.

`d` dispatches instead of attaching: the composer's text is sent to that peer's
`headless` profile (`--dispatch-profile` changes it), which answers one task and
exits. The prompt is quoted for the remote shell and SSH runs in `BatchMode`, so
a password prompt can never swallow the terminal; the peer's answer comes back
as an overlay, and the session it left behind stays the peer's to resume.

See [docs/fleet-overview.md](docs/fleet-overview.md) for why presence files
rather than the session store.

## Reaching it from another device

```sh
./scripts/serve-tailnet.sh on      # web UI on your tailnet, over TLS
./scripts/serve-tailnet.sh status
./scripts/serve-tailnet.sh off
```

`dsh web` stays bound to `127.0.0.1` — upstream states `--host 0.0.0.0` is
unsupported, and it would mean every interface, not just the tailnet — while
`tailscale serve` terminates TLS in front and the machine's tailnet name is
passed to `--trusted-host` so the browser-trust fence accepts it.

It is authenticated: a request from the tailnet without credentials answers
`401`, and a forged `Host` answers `403`. It also runs shell commands as you,
so the script prints a warning every time. See
[docs/remote-access.md](docs/remote-access.md).

## Several sessions at once

`ctrl+n` opens another session beside the current one rather than replacing it,
so a long-running turn keeps going while you start something else. With more
than one open, a bar appears under the header:

```
 · 1 tail docker logs │ ⠹ 2 vlan plan │ ● 3 skills question
```

`⠹` is a turn in flight, `●` is a finished answer you have not read, `·` is
seen. `alt+1`…`alt+9` jump straight to a session, `alt+n`/`alt+p` cycle,
`/sessions` opens a picker — which also carries a **+ Ask the harness in a new
session** entry, so starting one does not depend on already knowing `ctrl+n` —
and `/close` closes the current one. `x` on a row in that picker closes *that*
session without leaving the list, so tidying up several at once is not a
switch-then-`/close`-then-reopen-the-picker loop; the last session cannot be
closed this way either, the same guard `/close` already has.

**The bell.** When a session's turn finishes, the terminal bell rings — that is
the point of running several: you start one, go and do something else, and get
told when it is done. A session you are already looking at is marked seen
rather than nagged about. A background job that finishes rings the same bell
with a status line naming it, and so does a fleet dispatch returning from a
peer — anything the user has stopped waiting for gets announced, never just
the turns. `--no-bell` turns the sound off.

## Background agents

The transcript only ever shows the foreground agent, so a turn that delegates
to subagents would otherwise look idle while the machine is busy. Live agents
other than the current one appear in a strip above the composer:

```
 ⠹ 2 agents  1 running  ·  research, verify                              ctrl+b
```

`ctrl+b` expands it into a list with each agent's depth and age. It is fed by
the `agent/created`, `agent/status` and `agent/disposed` lifecycle events, and
the strip is the first chrome to collapse when the window is too short — the
transcript always wins.

## Choosing a model

`/model` opens a picker over everything the mounted adapters can serve,
grouped by provider, with the model in use marked:

```
 Models
 › g53

 z.ai (GLM coding plan)
    glm-5.3  GLM-5.3
    glm-5.3-flash  GLM-5.3-Flash

 ↑↓ move  ·  enter select  ·  esc back                                    2/7
```

The filter is a subsequence match, so `g53` finds `glm-5.3`. `/model <id>`
skips the picker; use `provider/model` when two routes serve the same id.

Switching re-resolves the agent against the **same session**, so the
conversation survives the change, and the choice is saved as the default for
new sessions. The model is **per session**: switching in one conversation
leaves every other tab on the model it was already using, and the footer's
model and context bar always describe the session on screen. A new session
starts from the model of the session it was opened from, then diverges
independently.

## Signing in — Claude Pro/Max, ChatGPT/Codex, and others

`/providers` opens a picker over every credential `ctx.authorization` knows how to
obtain — a human-guided sign-in a plain API key cannot replace, because
getting it means a conversation: open this page, paste that code, pick an
account. This app adds no provider knowledge of its own; it renders whatever
flows are registered, the same way `/plugins` lists whatever packages compose
the profile. In practice, mounting `@deepseek-ai/dsh-llm-pi-ai` — the same
adapter a coding-plan route like z.ai's already goes through — is what
registers a flow for each provider it ships a login for, **Anthropic (Claude
Pro/Max)** and **OpenAI Codex (ChatGPT Plus/Pro)** included, from the moment
the plugin mounts, whether or not a route for it is configured yet.

Picking an entry with one method starts it right away; more than one opens a
second picker for the method first (OAuth, a pasted key, and so on — most
preferred listed first). What happens next is whatever that flow asks for,
rendered as a panel that owns the keyboard until it settles:

```
 Sign in — GitHub Copilot

 Enter this code on the verification page to finish signing in.

 Open: https://github.com/login/device
 Code: `WXYZ-1234`

 enter opens the browser  ·  esc cancels the sign-in
```

The page lands on the clipboard the moment the notice does, not only once
`enter` asks to open it — the terminal you are actually in may not be the
machine whose browser can reach it (an SSH session, a remote box), and pasting
it there is the fallback `enter` cannot offer. `enter` on a bare notice like
this one *also* opens its page with the platform's own launcher
(`xdg-open`/`open`/`start`), for whichever of the two is faster; the code and
page stay on screen once the flow moves on to its own question, the way a
device-code flow needs them to. A flow that needs an answer — that pasted
code, an account to pick from a list — prompts for it the same way; `enter`
submits, `esc` declines just that question if the flow can recover, or
withdraws the whole attempt if nothing is being asked yet. Success or
cancellation lands as an ordinary status line, and the stored credential
outlives the app: signing in once is enough for every session afterward,
until you sign out through whatever surface manages that credential store.

Signing in authenticates the route; it does not by itself add one to `/model`.
That is a profile-level `dsh-llm-pi-ai` config, the same as any other route
(see its own README for the full field list):

```yaml
- name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      anthropic: {}
      openai-codex: {}
```

No `apiKeyEnv` is needed on either — a stored sign-in authenticates its route
beneath any key configured there, so an empty config is enough once `/providers`
has run.

## First run

On a fresh install the app opens with a short setup list: interface language,
color palette, provider sign-in (`/providers`), and the one shell command
voice control needs. Each row opens the picker or shows the step it names,
and closing the list — enter on the last row or `esc` — records that this
machine has seen it; it never returns unasked.

## Color palettes

`/theme` opens a picker over the palettes the app ships with; `/theme <name>`
switches straight away. Moving through the picker repaints the whole app in
the highlighted palette — browsing by arrow key *is* trying it on — and `esc`
puts back what was in force; `enter` keeps what you landed on. The same
preview applies to `/lang`. And `/theme <par<Tab>` completes a palette name,
shared prefix first, then opens the picker; `/lang <par<Tab>` does the same
for languages.

| Theme | |
|---|---|
| `moqi` | the default — the app's own: ink wash on Deep Ink, cinnabar for warning |
| `ayu` | warm neutrals, orange accent |
| `catppuccin` | soft pastels, easy on the eyes (Latte / Mocha) |
| `contrast` | saturated hues on pure black/white; maximum legibility |
| `dracula` | vivid neon on purple; dark canonical, light derived |
| `everforest` | muted organic greens, low glare |
| `gruvbox` | warm retro earth tones, medium contrast |
| `kanagawa` | sumi-e ink wash; wave dark, lotus light |
| `material` | Android's palette; Darker dark, Lighter light |
| `modus` | WCAG-contrast-checked pair; Operandi light, Vivendi dark |
| `monokai` | the classic vivid editor scheme; dark canonical |
| `nord` | cool arctic blues, low saturation |
| `one` | Atom's classic; One Light and One Dark |
| `paper` | a page and one red accent; ink dark twin |
| `phosphor` | green CRT glow; amber for warnings |
| `rose-pine` | muted purples on a soft ink background; the former default |
| `solarized` | Schoonover's balanced pairing |
| `synthwave` | hot pink on indigo; the outrun sunset |
| `tokyo-night` | city-night blues; Night dark, Day light |
| `tomorrow` | muted neutrals; hue as seasoning |
| `mono` | greyscale, maximum contrast, no color coding at all |

Every palette defines both a light and a dark variant, because *which* palette
is in force and *which background* it is drawn against are separate questions.
`MOQI_THEME=light|dark` still forces the variant (the `COLORFGBG`
convention decides otherwise, and dark is the fallback), and `NO_COLOR` or
`TERM=dumb` still turns color off entirely — under those the theme has nothing
to do and picking one changes nothing.

`mono` is the accessibility option: it drops the hues rather than trying to
keep them, so success and failure no longer differ by color. Nothing in the
app relies on color alone — a failed tool call prints `✗` and its error text
either way — so what is left is legible where a hue-based palette is not.
`contrast` is the other accessibility corner: it keeps the hues but pushes
each to a saturated extreme against a pure base, and `modus` is the
middle path — a pair built to published WCAG contrast guarantees.

`moqi` is the app's own and the default: a Chinese ink painting, which is
where the name comes from (墨气). Deep Ink ground, Xuan Paper text, Ink Wash
selection and borders, Slate Smoke for the muted layer; the accents stay in
the same vocabulary — cinnabar for warning, the way a seal stamp carries the
painter's mark, an indigo wash for the accent, celadon, bamboo, and ochre for
the semantic slots. The light variant is the same painting on paper: the same
inks, the accents pressed darker to carry on Xuan.

Where a palette publishes both variants, both are used as published (the
exceptions are documented in the table: Dracula, Monokai, and Nord have no
light variant of their own, so one is derived from their hues the same way);
`paper`, `phosphor`, `synthwave`, and `contrast` are this app's own, built for
styles no published palette covers — minimal paper, the green CRT, the outrun
sunset, and maximum-contrast color.

The choice is saved with the rest of the durable state and applied before the
first frame, so it survives a restart. Switching repaints the whole screen at
once, since a palette change moves the color of nearly every cell.

The theme is **per session**, the same way the model is: `/theme` in one
conversation leaves every other tab on the palette it already had, switching
tabs repaints in whichever one that tab is on, and a new session starts from
the theme of the one it was opened from rather than the stored default —
which is still what a session started *without* one, like the very first tab
of a fresh launch, falls back to. A restored session brings its own theme back
too; one this build no longer ships (renamed or removed since) falls back to
the current default instead of leaving the tab on nothing.

## Vim mode

`--vim` at launch turns the composer modal. It starts in INSERT — enabling vim
never changes what typing does — and `esc` switches to NORMAL, where the
footer shows the mode and bare keys follow vim:

| NORMAL key | |
|---|---|
| `h` / `l` / `0` / `^` / `$` / `w` / `b` | motion, with vim's word-start `w` rather than readline's end-of-word |
| `i` / `I` / `a` / `A` / `o` / `O` | enter INSERT at, before, after, or on a new line |
| `x` / `X` / `dd` / `d$` / `d0` / `dw` | delete a character, a line, to the end, to the start, a word |
| `u` | undo the last vim edit (100 deep) |
| anything unbound | swallowed, so a stray `j` cannot type |

While vim mode is on, `esc` belongs to the editor: `ctrl+c` is the interrupt,
which is also what the footer's mode badge is there to remind you of. The mode
is session-scoped and not persisted, and the vim layer only ever touches the
composer — a panel, picker, or fleet screen owns the keyboard when it is open.

## Interface language

`/lang` switches the interface between English and Simplified Chinese and
remembers the choice across restarts. The translated surface is the chrome you
read: the welcome, the full key reference, the trust panels, and the footer
hints. Operational status lines stay English on purpose — they are diagnostics
that change with every release, and a half-translated diagnostic is worse than
an English one. A missing key falls back to English and then to its own name,
so nothing ever renders blank.

## MCP servers

`/mcp` shows which MCP servers' tools are mounted here, grouped by server, by
reading the tool registry for bridge-prefixed names (`mcp__server__tool`,
`server/tool`). Servers are declared by composition, not at runtime, so the
pane says where to add one instead of pretending to manage them live — and it
recognizes MCP patterns narrowly enough that a path like `src/tui/state.ts` is
never mistaken for a server.

## Extending the terminal

The app provides `ctx.tuiHost`, a service other plugins extend it with:

```ts
const dispose = ctx.tuiHost.registerShortcut({
  combo: 'ctrl+shift+g', label: 'git status', handler: () => { /* … */ },
})
ctx.tuiHost.setStatusLine('2 agents spinning')

// A command panel: `<name>` joins the palette; the host draws the rows,
// routes `enter`, and raises any masked prompt the panel asks for.
ctx.tuiHost.registerPanel({
  name: 'JevLoop',
  title: 'Jev Loop',
  description: 'Jev gates and API key (moqi-jev-loop)',
  rows: () => [{ id: 'gate', title: 'Pre-execute', subtitle: 'on', active: true }],
  activate: (id) => { /* toggle, or return { kind: 'secret', message, submit } */ },
})
```

A shortcut must carry `ctrl` or `alt`; a combination the app already uses is
refused rather than ordered, so a plugin can never swallow the quit
confirmation or a scroll key. `registerShortcut`, `setStatusLine`, and
`registerPanel` all return disposers, and the status line is one row —
replaced, not stacked, last registration wins — that the layout surrenders
first when the window is short. A panel owns what its rows mean; the host owns
how they look and which keys drive them. A panel is a fallback command, not an
override: if its name collides with a built-in or a Harness command, the app's
command wins in both the palette and `/name`. The host side of the seam lives in
one framework-free module, `src/tui/panel-host.ts`, so an action that throws
leaves the panel open rather than vanishing behind the error; the seam and its
adapter are drawn in [`docs/whiteboards/`](docs/whiteboards/).

Searching across sessions is built in: `/find --sessions <text>` reads the
stored session logs (plain or zstd) under `$DSH_HOME/sessions`, shows every
matching line with its project and speaker, and opens the session on `enter`.
The store is read-only here; a compressed log on a Node too old to decode it is
reported as skipped, never as a wrong answer.

## Rate, cache, usage, and background jobs

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

## Rewinding and forking

`/rewind` lists every prompt in the conversation; picking one forks the session
at the start of that prompt's turn, restores the prompt into the composer, and
opens the fork beside the original. The original is untouched, so trying a
different wording costs nothing — and the first prompt cannot be rewound past,
because there would be nothing left to inherit.

`/fork` copies the whole conversation into a resumable twin, cut at the last
completed turn so the seed is always a balanced prefix. `/tree` shows the
family: the lineage of forks this session belongs to, oldest ancestor first.

Forks are real Harness sessions (`parentSession` plus a seeded prefix), so they
appear in `/resume`, survive restarts, and can themselves be rewound or forked.

## When the agent stops to ask

Three moments hand the keyboard to a panel in place of the transcript, and all
three answer through the Harness's own seams — the `approval/request` and
`user-questions/request` waterfalls — so no answer is faked and a headless
mount fails closed rather than swallowing a prompt it cannot show.

**Tool approval.** When the permission layer needs a decision, the panel shows
the tool, the exact command from the tool call already in the transcript, and
the asker's reason: `1` allows once, `2` or `esc` denies. The protocol has no
persistent grant, so nothing offers one.

**`ask_user_question`.** Options navigate with `↑`/`↓`, `space` toggles a
multi-select, `enter` answers and advances, `tab` moves to the free-text line,
and `esc` steps back a question before it cancels the set (`ASK_CANCELLED`).
Typing on an option row answers with that option plus your text, the way a
form does.

**Answering by voice.** With push-to-talk configured, `ctrl+v` while an
approval panel is open records a take and reads it: an unambiguous "allow" or
"deny" (or 允许 / 拒绝) decides the request, while anything ambiguous leaves the
panel waiting — the microphone can never grant a tool call on a misheard
sentence, and a denial wins when both words appear. The same precedence applies
to `esc`: it cancels a live recording before it denies anything.

**Plan review.** `exit_plan_mode` renders the plan as markdown with its own
Approve / Keep-planning options. Approving never carries feedback — the
protocol reads feedback as "keep planning" — so typing while feedback is not a
decision is kept as feedback only on a declining answer.

## Commands

The palette merges two sources, so it shows whatever the Harness has actually
registered — `/compact` from `command-compact`, plus anything a plugin adds —
alongside the app's own:

| Command | Owner |
|---|---|
| `/compact`, and any other plugin command | `ctx.commands` (the Harness registry) |
| `/new`, `/sessions`, `/close`, `/resume`, `/delete`, `/rename`, `/model`, `/theme`, `/plugins`, `/thinking`, `/tools`, `/usage`, `/export`, `/find`, `/unqueue`, `/interrupt`, `/copy`, `/rewind`, `/fork`, `/tree`, `/jobs`, `/mcp`, `/lang`, `/providers`, `/dispatch`, `/fleet`, `/peer`, `/update`, `/help`, `/exit` (`/quit`) | this app |

Unknown commands are dispatched to `ctx.commands.execute()` and only reported
as unknown if the registry also rejects them.

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
  (including a running sign-in), the plugin seam, i18n, the fleet, and the
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

## Release steps

Publishing is automated: run the gates below locally, then publish a GitHub
Release whose tag matches `package.json` (`v0.3.0` for `0.3.0`) and the
[Publish to npm](.github/workflows/publish.yml) workflow runs them again on a
clean machine before publishing with provenance. It is triggered by the
Release rather than by a push, because npm rejects an existing version and a
workflow that bumped one for you would turn an ordinary merge into a release
nobody decided on. The one-time npm-side setup — trusted publishing, so no
long-lived token is stored — and the dry-run path are in
[`docs/releasing.md`](docs/releasing.md).

```sh
npm test              # 34 suites, including the pty round trip
npm run test:live     # a real model turn through the TUI (needs credentials)
npm run test:package  # packs, installs into a clean prefix + DSH_HOME, boots
npm run build         # and commit lib/ — see below
npm publish           # prepublishOnly re-runs build + typecheck + npm test
```

**`lib/` is committed, and has to be rebuilt and committed with any source
change.** The dshfind registry inspects this repository's public source tree
and requires the manifest's `main` to be a file that is actually in it; build
output that only appears after `npm run build` fails its check with
`missing_file`. The cost of that is a build artifact in git, and the risk is a
stale one — if `lib/` lags `src/`, the registry describes different code than
npm ships. `tsc` output is deterministic for a given source and compiler, so
`npm run build && git diff --exit-code lib` says whether the tree is honest.

`prepublishOnly` runs all four gates, so publishing needs `dsh` on `PATH` — a
broken artifact must fail the publish rather than reach the registry.

`test:package` exists because the suites all run from the source checkout,
where `link-types` has already made the Harness resolvable — which is exactly
how a tarball that could not resolve `@deepseek-ai/*` once passed every test
and still crashed on boot. It now fails the release instead.

## License

MIT.

[![SonarQube Cloud](https://sonarcloud.io/images/project_badges/sonarcloud-light.svg)](https://sonarcloud.io/summary/new_code?id=JWE24-code_moqi)
