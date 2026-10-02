# Reaching the Harness from another device

Three ways, in increasing order of how much you expose.

## 1. SSH — nothing to secure

```sh
ssh workstation
dsh --profile tui
```

The TUI is a terminal app, so this works today with no configuration. It is one
session at a time and gives no overview, but it exposes nothing: SSH is already
the boundary.

## 2. The web UI on your tailnet

```sh
./scripts/serve-tailnet.sh on      # start it
./scripts/serve-tailnet.sh status  # see what is exposed
./scripts/serve-tailnet.sh off     # stop it
```

This keeps `dsh web` bound to `127.0.0.1` and puts `tailscale serve` in front,
which terminates TLS with a real certificate and is reachable only inside the
tailnet. The machine's tailnet name is passed to `--trusted-host`.

### Why not `--host 0.0.0.0`

Upstream states it plainly: *"`dsh web --host 0.0.0.0` remains unsupported."*
`host` accepts only `127.0.0.1` or `0.0.0.0`, and `0.0.0.0` is **every**
interface — your LAN and VLANs too, not just the tailnet. There is no way to
bind the tailscale interface alone, which is exactly why the proxy is the right
shape: the app keeps the posture it supports and the tailnet does the exposing.

### What actually protects it

Not nothing — this was measured against a running instance, not assumed:

| Request | Response |
|---|---|
| Tailnet URL, no credentials | `401` — host trusted, authentication required |
| Forged `Host: evil.example` | `403` — browser-trust fence rejects |
| `http://127.0.0.1:3080/api` | `401` |

Two layers do this. The trust fence (`api-request-trust`) requires `Host` to be
loopback or a configured `trustedHosts` entry, requires any `Origin` to equal
that `Host`, and refuses `sec-fetch-site: cross-site` — it defends DNS
rebinding and cross-site requests, and establishes no identity. Above it,
`BrowserAuth` requires a signed, `HttpOnly`, `SameSite=Strict`, host-bound
cookie, bootstrapped by the one-time `?token=` URL the app prints and signed
with the `client-connection/browser-session` grant in
`~/.dsh/.credentials.yaml`.

### What you are accepting

The Harness runs shell commands as your user. Anyone who reaches this endpoint
**and authenticates** has remote code execution on that machine — by design.
That is a larger prize than a password vault, so:

- Keep tailnet ACLs tight; every tailnet device can reach the port.
- The `?token=` URL is a credential. Treat it like a password.
- To invalidate every browser session, delete the
  `client-connection/browser-session` record from `~/.dsh/.credentials.yaml`
  and restart the web app.
- **Never** `tailscale funnel` this. Funnel is the public internet.

## 3. The API gateway directly

Don't. It is the same surface as (2) without the TLS and without the tailnet
boundary. If you want programmatic access, `dsh --profile acp` and
`dsh --profile sdk` speak over stdio, which tunnels through SSH and exposes no
port at all.

## Cross-device session overview

See [sessions-overview.md](sessions-overview.md). That design deliberately needs no
listener: each device publishes small presence records under `$DSH_HOME` and
peers are read over SSH, so there is nothing extra to secure.
