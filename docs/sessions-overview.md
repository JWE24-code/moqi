# Cross-device Sessions view

One list of every dsh session across every device, with status, and a way to
open any of them.

## Recommendation

**Publish a presence file per session; read peers over SSH.** No new daemon, no
new port, no new credentials.

Each running TUI writes one small JSON record per open session under
`$DSH_HOME/tui-presence/`, refreshed every few seconds and deleted on exit. The
overview reads its own directory and `cat`s each peer's over SSH, merges, and
sorts. A record that has not been refreshed within 30s is reported `stale`
regardless of what it claimed, so a laptop that sleeps mid-turn stops asserting
that it is running.

Why presence files rather than the session store: `session.lock` in
`~/.dsh/sessions/<cwd>/<id>/` is an **empty flock target that outlives the
process**, so its presence is not a liveness signal — verified on this machine,
where every dead session still has one. The durable log
(`session.v3.jsonl.zstd`) does carry a `session/title` event and the full
history, but answering "what is running right now" would mean decompressing one
zstd file per session per device on every refresh. The owning app already knows
its own status exactly; having it say so is cheaper and more accurate.

## The options, and why not the others

| Approach | Verdict |
|---|---|
| **(a) SSH + remote `dsh --profile tui`** | Works today, zero code. But it is one session at a time and gives no overview — it is the *jump* mechanism, not the *list* mechanism. Used here for exactly that. |
| **(b) Presence files + SSH pull** | **Chosen.** Read-only, no listener, no auth to invent, degrades cleanly when a device is off. |
| **(c) Reading session logs over a shared/synced path** | Rejected as the primary source: a zstd decompress per session per device per refresh, and it still cannot distinguish "running" from "exited mid-turn". Useful later for *history*, not for live status. |
| **(d) The API gateway / `dsh web`** | **Do not expose this.** `dsh-host-webserver` accepts only `127.0.0.1` or `0.0.0.0`, and its own README states it carries **no TLS, no authentication and no origin policy**; `dsh-client-connection` assumes loopback. Binding `0.0.0.0` publishes every route and the whole SPA to the network. If you ever want browser access, put it behind the Caddy + auth you already run — never bind it directly. |

## Security posture

- **Nothing new listens.** The only transport is SSH, which is already
  authenticated, encrypted, and working key-only between these machines
  (verified against `workstation` with `BatchMode=yes`).
- Records are written `0600` in a `0700` directory, and carry no secrets — a
  session id, a title, a status, a model name, a pid.
- A title can contain the first words of a prompt. If that is sensitive, do not
  publish; the feature is opt-in per device by simply not enabling it.
- Remote reads are non-interactive (`BatchMode=yes`), so a missing key fails
  fast and visibly instead of hanging the UI on a password prompt.

## Status vocabulary

| Status | Meaning |
|---|---|
| `running` | A turn is in flight on that device. |
| `ready` | A turn finished and the answer has not been seen. This is the one worth a bell. |
| `idle` | Open, nothing pending. |
| `stale` | No heartbeat within 30s — the device slept, the app was killed, or the network is gone. Derived, never published. |

## Jumping to a session

```sh
# local
dsh --profile tui --resume <session-id>
# remote — the same way you reach the device itself
ssh -t <host> 'dsh --profile tui --resume <session-id>'
```

`jumpCommand()` builds exactly this. Driving a remote session *in place* from
the local UI is deliberately out of scope: it would need the gateway, which has
no auth.

## Layout

| File | Role |
|---|---|
| `src/tui/fleet.ts` | Pure: record shape, validation, merge, staleness, ranking, rendering, jump command. No fs, no SSH, no Harness. |
| `src/presence.ts` | Writes and withdraws this device's records. |
| `src/fleet-sources.ts` | Reads local records and peers over SSH, in parallel. |
| `tests/fleet-smoke.ts` | 144 assertions over the pure logic plus a real presence round trip. |
| `tests/fleet-live.ts` | Manual check against real hosts. |

## Using it

Press `ctrl+s`, or type `/sessions`. The list groups by device, most urgent first
within each one, and refreshes with `r`.

`enter` opens the highlighted session when this app already owns it. It cannot
open anything else: a session in another process — on this machine or another
one — has no terminal here. Rather than pretend, the command that does reach it
goes on the clipboard:

```sh
ssh -t <host> 'dsh --profile tui --resume <session-id>'
```

Add devices with a repeatable flag:

```sh
dsh --profile tui --peer laptop --peer workstation
```

Each peer is read with one short, non-interactive SSH command. Nothing is
installed there beyond `dsh` itself, and nothing listens anywhere.

The first row under this device starts a conversation: `enter` on
`+ Ask the harness in a new session` opens one here, the same as `ctrl+n`, and
the row is never counted as a session. `k` closes the highlighted session when
this app owns it; a session on a peer, or in another process here, is left
alone because there is no per-session control channel.

## Status of this work

Wired and verified end to end. A live run under a pseudo-terminal was checked
against the real app: a record appears in `$DSH_HOME/tui-presence/` while a
session is open, `ctrl+s` renders the device's own session grouped under its
hostname, and the record is removed again when the process is told to stop —
so a device that exits does not linger in anyone else's list as stale.

Worth knowing: until a second device actually runs `dsh`, the overview
correctly shows a single device — worth remembering when the list looks
emptier than expected.
