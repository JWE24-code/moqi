# Using moqi

Day-to-day interaction: steering a running reply, completions, tool calls,
search, the clipboard, voice, multiple sessions, models, sign-in, and forking.

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
carries `✓`, or `✗` with its error. Calls start collapsed — one row each — so a
long turn stays readable; `ctrl+o` adds each call's outcome underneath the call
that produced it, and the choice is remembered across restarts:

```
 ✓ bash  docker ps
   ↳ webui postgres
```

A file edit does not show its result line — `str_replace_editor` only answers
"The file … has been edited successfully", which says nothing. Instead the
expanded row is the change itself: a removed row is a red bar, an added row a
green one, each carrying its row number, with three rows of context either
side, so the edit can be read without opening the file. The bar's text color is
chosen by measured contrast against it, so the same palette stays readable on a
light and a dark terminal:

```
 ✓ str_replace_editor  src/tui/view.ts
      10   const before = 1
      11   const keep = 2
      12   const also = 3
      13 - const gone = 4
      13 + const replaced = 5
      14   const after = 6
      15   const more = 7
      16   const end = 8
```

The lines come from the call's arguments. The row numbers and the context come
from the file, read once the call settles; a file that cannot be read (deleted,
or already changed again) still shows the hunk, just without numbers.

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

## Sessions across every device

```sh
dsh --profile tui --peer laptop --peer workstation
```

`ctrl+s` (or `/sessions`) shows every dsh session across every device, grouped by
machine, most urgent first, with a status mark and the age of each heartbeat.

```
 Sessions
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
disconnecting) returns you to the Sessions view here, repainted. This needs
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

See [docs/sessions-overview.md](docs/sessions-overview.md) for why presence files
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

The design behind Sessions is in [docs/sessions-overview.md](sessions-overview.md);
reaching the app from another device over tailnet is in
[docs/remote-access.md](remote-access.md).

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
with a status line naming it, and so does a dispatch returning from a
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
