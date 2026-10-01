#!/usr/bin/env bash
#
# Serve the Harness web UI to your tailnet, and only your tailnet.
#
# The app keeps its supported loopback binding (`dsh web --host 0.0.0.0` is
# explicitly unsupported upstream); `tailscale serve` terminates TLS and
# forwards to 127.0.0.1. The tailnet name is passed to `--trusted-host` so the
# browser-trust fence accepts it — without that every request answers 403.
#
#   ./scripts/serve-tailnet.sh on      start the web app and the tailnet proxy
#   ./scripts/serve-tailnet.sh off     stop the proxy (and this script's app)
#   ./scripts/serve-tailnet.sh status  show what is exposed right now
#
set -euo pipefail

PORT="${DSH_WEB_PORT:-3080}"
STATE_DIR="${XDG_RUNTIME_DIR:-/tmp}/dsh-tui-serve"
PID_FILE="$STATE_DIR/web.pid"
LOG_FILE="$STATE_DIR/web.log"

die() { printf '%s\n' "$*" >&2; exit 1; }

command -v tailscale >/dev/null || die 'serve-tailnet: tailscale is not installed'
command -v dsh >/dev/null || die 'serve-tailnet: dsh is not on PATH'

# The tailnet DNS name of this machine, without the trailing dot.
tailnet_name() {
  tailscale status --json 2>/dev/null |
    python3 -c 'import json,sys; print((json.load(sys.stdin).get("Self") or {}).get("DNSName","").rstrip("."))'
}

# The banner is printed with printf, and the heredoc that feeds it is quoted.
# An unquoted heredoc would treat this prose as shell: an early draft wrote
# "tailscale funnel" in backticks and the shell duly ran it.
warn_banner() {
  local host="$1"
  local rule='  ────────────────────────────────────────────────────────────────────────'
  {
    printf '\n%s\n' "$rule"
    printf '%s\n' "   WARNING — this exposes an agent that runs shell commands as ${USER}."
    printf '%s\n' ''
    printf '%s\n' "   Reachable at  https://${host}/  by every device and user on your tailnet."
    printf '%s\n' '   Anyone who reaches it and authenticates can run commands on this'
    printf '%s\n' '   machine. That is what the Harness is for; it is still remote code'
    printf '%s\n' '   execution, and a bigger prize than a password vault.'
    printf '%s\n' ''
    printf '%s\n' '   It is NOT wide open: the browser-trust fence answers 403 to any other'
    printf '%s\n' '   Host, and an unauthenticated request answers 401. Access needs the'
    printf '%s\n' '   one-time ?token= URL below, which then sets a signed 30-day cookie.'
    printf '%s\n' ''
    printf '%s\n' '   Keep tailnet ACLs tight. Do NOT put this behind tailscale funnel --'
    printf '%s\n' '   that is the public internet.'
    printf '%s\n' "   Turn it off with:  ${0} off"
    printf '%s\n\n' "$rule"
  } >&2
}

case "${1:-status}" in
  on)
    HOST="$(tailnet_name)"
    [[ -n "$HOST" ]] || die 'serve-tailnet: could not read this machine'\''s tailnet name; is tailscaled up?'

    mkdir -p "$STATE_DIR"
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "serve-tailnet: web app already running (pid $(cat "$PID_FILE"))"
    else
      # Loopback bind is deliberate: the proxy is the only way in.
      nohup dsh web --no-open --port "$PORT" --trusted-host "$HOST" >"$LOG_FILE" 2>&1 &
      echo $! >"$PID_FILE"
      echo "serve-tailnet: started the web app on 127.0.0.1:$PORT (pid $(cat "$PID_FILE"))"
      # Give it long enough to bind and print its token URL.
      for _ in $(seq 1 40); do
        grep -q 'token=' "$LOG_FILE" 2>/dev/null && break
        sleep 1
      done
    fi

    tailscale serve --bg "http://127.0.0.1:$PORT" >/dev/null
    warn_banner "$HOST"

    echo "Open this once, on the device you want to use:"
    echo
    sed -n 's|.*http://127\.0\.0\.1:[0-9]*\(/?token=[A-Za-z0-9_-]*\).*|  https://'"$HOST"'\1|p' "$LOG_FILE" | tail -1 # NOSONAR — the http:// here is the loopback URL this script just matched in a log line, not a clear-text connection.
    echo
    echo "The token is a bootstrap credential — treat it like a password."
    echo "To invalidate every browser session, delete the"
    echo "client-connection/browser-session record from ~/.dsh/.credentials.yaml"
    echo "and restart the web app."
    ;;

  off)
    tailscale serve --https=443 off >/dev/null 2>&1 || true
    echo 'serve-tailnet: tailnet proxy stopped'
    if [[ -f "$PID_FILE" ]]; then
      PID="$(cat "$PID_FILE")"
      if kill -0 "$PID" 2>/dev/null; then
        kill "$PID" 2>/dev/null || true
        echo "serve-tailnet: stopped the web app (pid $PID)"
      fi
      rm -f "$PID_FILE"
    fi
    ;;

  status)
    echo '=== tailscale serve ==='
    tailscale serve status 2>&1 || true
    echo
    echo '=== listening sockets for the web app ==='
    ss -ltn 2>/dev/null | grep ":$PORT" || echo "nothing listening on $PORT"
    echo
    HOST="$(tailnet_name)"
    if [[ -n "$HOST" ]] && tailscale serve status 2>/dev/null | grep -q "$HOST"; then
      warn_banner "$HOST"
    fi
    ;;

  *)
    die "usage: $0 {on|off|status}"
    ;;
esac
