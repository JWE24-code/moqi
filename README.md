# Moqi

*默契 — the unspoken understanding between you and your harness.*

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

A terminal app for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
packaged as a `dsh` profile. A good terminal agent is one you stop having to
explain yourself to: Moqi keeps the conversation in the order it happened,
puts each tool call where it was made, and gets out of the way.

## Highlights

- **Tool calls, where they happened** — each call renders inline between the
  prose on either side of it, collapsed to one row with its own spinner and
  status; `ctrl+o` opens the outcome underneath
  ([docs/using-moqi.md](docs/using-moqi.md#tool-calls-where-they-happened)).
- **Steer, queue, or interrupt** a running reply — three destinations, one per
  key ([docs/using-moqi.md](docs/using-moqi.md#steering-queueing-and-interrupting-a-running-reply)).
- **Several sessions at once** — tabs with live status, a bell when a
  background turn finishes ([docs/using-moqi.md](docs/using-moqi.md#several-sessions-at-once)).
- **Sessions across devices** — every dsh session on every device, over plain
  SSH; preview or dispatch to a peer without leaving the terminal
  ([docs/using-moqi.md](docs/using-moqi.md#one-list-of-every-device)).
- **`/usage`** — plan limits and billed token spend, per provider, in rolling
  5-hour and 7-day windows ([docs/usage.md](docs/usage.md)).
- **Provider sign-in** — Claude Pro/Max, ChatGPT/Codex, and other OAuth flows,
  from inside the terminal
  ([docs/using-moqi.md](docs/using-moqi.md#signing-in--claude-promax-chatgptcodex-and-others)).
- **Voice dictation** — local whisper.cpp, push-to-talk with `ctrl+v`; nothing
  leaves the machine ([docs/using-moqi.md](docs/using-moqi.md#dictating-with-your-voice)).
- **Rewind and fork** — branch a conversation at any earlier prompt
  ([docs/using-moqi.md](docs/using-moqi.md#rewinding-and-forking)).
- **21 color palettes**, light and dark, with an accessibility-minded `mono`
  and `contrast` ([docs/reference.md](docs/reference.md#color-palettes)).
- **Extensible** — other plugins register shortcuts, status lines, and command
  panels through `ctx.tuiHost` ([docs/extending.md](docs/extending.md)).

Full key reference, flags, and commands: [docs/reference.md](docs/reference.md).

## Install

Requires a working `dsh` on `PATH` (`npm install -g @deepseek-ai/dsh`) and
Node 22+.

```sh
npm install -g moqi-tui
moqi
```

The launcher installs the profile and hands the terminal to dsh. From source:

```sh
git clone https://github.com/JWE24-code/moqi ~/Projects/moqi
cd ~/Projects/moqi
npm install && npm run build
npm run install-profile
dsh --profile tui
```

What the installer writes and how typechecking links the Harness's own types:
[docs/install.md](docs/install.md).

## License

MIT.

[![SonarQube Cloud](https://sonarcloud.io/images/project_badges/sonarcloud-light.svg)](https://sonarcloud.io/summary/new_code?id=JWE24-code_moqi)
