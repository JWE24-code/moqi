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

## Approvals and permission rules

When the agent needs your say-so — most often a command the sandbox refused,
retried with an escalation — the approval panel shows the exact command (read
from the session log, newlines and all) and the reason, with up to four rows:

```
 Allow bash?
 escalate sandbox to danger-full-access: the path lies outside the workspace…
   │ touch /tmp/outside/one.txt
 ❯ Allow once
   Allow for this session  bash(touch *) @ danger-full-access
   Always allow            bash(touch *) @ danger-full-access · this project (tab: everywhere)
   Deny
```

`1`–`4` pick a row, `tab` flips "always" between this project and everywhere,
`esc` denies. "This session" lasts as long as the session (a fork keeps it);
"always" is written to `$DSH_HOME/moqi/permissions/` — per project, keyed like
the session store, or `global.yaml` — never into the repository, so a cloned
repo can't ship its own grants.

The next call a rule covers is answered without a panel, and the status line
names the rule: `allowed by rule bash(touch *) @ danger-full-access · session`.
The Harness still audits every decision. A rule only answers an escalation to
the mode it names or a narrower one, and a compound command is covered only if
every part is — anything with a substitution, a redirect other than
`/dev/null`, or input redirection always asks. When no exact rule can be
stated (a chained command, say), the panel offers once or deny only. A spoken
answer only ever allows once.

**`/permissions`** lists every rule in force for the session you're in,
grouped under *This session*, *This project*, and *Everywhere*. `enter` on a
rule asks before revoking it; the two rows at the end open the project or
everywhere rules file in `$VISUAL`/`$EDITOR`. Rules are read fresh at every
approval, so an edit is live the moment you save. A file that no longer reads
as rules is reported, and its rules are off until it is fixed — never guessed
at.

## Session modes

`shift+tab` steps the session through three modes, each built from the
Harness's own permission presets and plan mode:

| Mode | The agent… | Footer |
|---|---|---|
| `read-only` | reads, but cannot change files | `read-only` |
| `workspace-write` | changes files in its workspace — the everyday default | (nothing) |
| `plan` | explores and proposes a plan you approve before it acts | `plan` |

Plan mode keeps the workspace-write sandbox, so a plan you approve can be
carried out straight away. Full access is never a `shift+tab` step: it takes
`/permission danger-full-access`, the footer then shows `⚠ full access`, and
the next `shift+tab` goes back to read-only. A switch made mid-reply takes
effect from the agent's next step. The mode belongs to the session: other
tabs keep theirs.

## Memory

The agent can keep facts across sessions with three tools: `memory_save`,
`memory_read`, and `memory_forget`. A memory is one fact — who you are and how
you like to work, a correction (with why), a project decision not in the code,
a pointer to an outside resource — saved as a small markdown file with an
index line in `MEMORY.md`:

```
$DSH_HOME/memory/                         everywhere
$DSH_HOME/memory/projects/<project>/      this project only
```

Every session carries the index of both, so the agent knows what it knows
without reading anything, and opens a memory with `memory_read` when it is
relevant. The index is runtime context, read fresh for every request: a memory
saved in any session — or added with `# `, or edited in `$EDITOR` — reaches
every open session at its next request. The Harness appends a new copy to the
conversation only when the list actually changed, after the cached history, so
an unchanged list costs nothing and the system prompt and its cache are never
rewritten.

Memory is separate from the instruction files the Harness already loads
(`$DSH_HOME/AGENTS.md`, the project's `AGENTS.md`/`CLAUDE.md`): those are
yours to write; memory is the agent's notebook. Both are plain files you can
edit or delete.

**Switching memory off.** `/memory off` turns memory off for every session at
once and is remembered across restarts; `/memory on` brings it back. While
off, no session gets the memory list or the memory tools (from each one's next
request), a `# ` note offers only the `AGENTS.md` rows, and the footer says
`memory off`. Nothing is deleted — saved memories wait on disk, and `/memory`
still opens them. `--no-memory` (or `MOQI_MEMORY=off`) does the same for one
run without changing the stored choice.

**`/memory`** shows both side by side for the session you're in: the
instruction files the Harness actually loads here (with a `+ create` row for
a missing global or project-root `AGENTS.md`), the memories for this project
and for everywhere, and the two `MEMORY.md` index files. `enter` opens the
file in `$VISUAL`/`$EDITOR`; type to filter. `/memory forget <name>` removes
a memory after asking. An edited memory reaches every new session; an edited
instruction file is picked up by the Harness after the agent's next file
action, or on resume.

**`# ` quick-add.** A one-line entry that starts with `# ` is a note to keep,
not a prompt — it never reaches the model, whether you press `enter`, `tab`,
or `ctrl+enter`. A small picker asks where it goes:

```
 Keep “tests run with make check”
 Memory — the agent’s notebook
    Remember for this project
    Remember everywhere
 Instructions — yours, always loaded
    Add to this project’s AGENTS.md
    Add to ~/.dsh/AGENTS.md
```

Memory saves it as its own memory (a note whose title matches an existing
one gets a numbered name, never replacing it); instructions append it as a
`- ` bullet to the project root's `AGENTS.md` or the global one, creating the
file if needed. `esc` keeps nothing — `↑` brings the line back. A bare `#`,
`#tag`, or a multi-line paste that opens with a heading is sent as usual.

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
  + Ask the harness in a new session                                 ctrl+n
  ⠹ rebuild the search index   deepseek-chat                            3s
  · draft the release notes    deepseek-chat                           12m

 laptop
  ● summarise yesterday        glm-4.7                                  8s

 ↑↓ move  ·  enter open  ·  k close  ·  a add  ·  x remove  ·  r refresh  ·  esc back            3 sessions
```

The group for this device carries a `+ Ask the harness in a new session` row:
`enter` on it starts a fresh session here, the same as `ctrl+n`. `k` closes
the highlighted session when this app owns it — a session on a peer, or in
another process on this machine, has no per-session close channel from here.

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

## Branches and worktrees

A session's working directory is fixed when it opens, so moqi decides *where*
its changes land at that moment.

**Branch, the default.** A new session in a git repository starts on a branch
of its own — `moqi/2026-10-18-f354` — created in place from whatever branch
you were on. Nothing is copied: the same files, the same `node_modules`, which
is what you want for a one-file fix. Uncommitted changes travel with the
switch. The footer shows the branch (`⎇ moqi/…`) and follows it when the model
switches branches itself. A checkout has one HEAD, so a second session opened
in the same checkout **shares** that branch rather than switching it under the
first. `/branch <name>` creates or switches to `moqi/<name>` for the current
session; it is refused while another session in the same checkout is
replying. No branch is started on a detached HEAD or mid-rebase, merge,
cherry-pick, revert, or bisect — the status line says why.

**Worktree, for real isolation.** `/worktree <name> [--base <ref>]` opens a new
session in a separate checkout on `moqi/<name>`, under
`$DSH_HOME/worktrees/<project>/<name>` — outside the repository, so Node never
walks up into the main checkout's `node_modules`. The base is your current
HEAD, unpushed commits included, unless `--base` names another ref. A worktree
is a full checkout: install dependencies there if the task needs them.

**Closing cleans up only what changed nothing.** `/close` on a session whose
branch has no commits of its own switches back to the branch it came from
(recorded in the repo's config, so this survives a restart) and deletes it; a
worktree goes when it is also clean. Anything with commits or uncommitted work
is kept and the status line says where. Quitting never cleans up — open
sessions come back on the next launch, on the branch or worktree they had.

**The model is told, so you don't have to.** Every isolated session carries
its own workspace rules in the system prompt — an AGENTS.md block moqi writes
from the session's real state: the branch to commit to, the base not to touch,
and either "this checkout is shared: never switch branches, stash, reset, or
rebase" or "this is a fresh worktree: install dependencies before building".
It is scoped to that one session and stays byte-identical for the life of the
branch, so it costs no prompt-cache misses. Sessions that are not isolated get
nothing.

**Leftovers tidy themselves.** On launch moqi removes its own branches and
worktrees that hold no work and that no open session uses — sessions that
were quit and never resumed. The rule is the same as `/close`: no commit of
its own, and for a worktree nothing uncommitted. Worktrees are locked with
the owning process's pid, so a second moqi running elsewhere never has a live
worktree pruned from under it.

`/isolation off|branch|worktree` changes what new sessions do and remembers it;
`--isolation` (or `MOQI_ISOLATION`) overrides it for one run. The Harness
sandbox still confines writes to the session's directory, so a worktree
session cannot write into the main checkout.

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
