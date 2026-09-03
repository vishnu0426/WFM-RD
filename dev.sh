#!/usr/bin/env bash
# Starts/stops the whole Agno WFM platform locally with one command.
# See RUN.md for what this actually does under the hood and the one-time
# setup (creating the database, running scripts/init-roles.sql) this script
# assumes already happened.
#
# Usage:
#   ./dev.sh start          # start infra + every backend service + web-console
#   ./dev.sh start core     # start infra + only the root service (fastest inner loop)
#   ./dev.sh stop           # stop everything this script started
#   ./dev.sh status         # show what's running
#   ./dev.sh logs <name>    # tail one service's log (e.g. ./dev.sh logs intraday-service)
#   ./dev.sh logs           # tail every log at once
#
# Each service's own stdout/stderr goes to logs/<name>.log. PIDs are
# tracked in .pids/<name>.pid so `stop`/`status` know what to look for.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$PWD"

LOG_DIR="$ROOT/logs"
PID_DIR="$ROOT/.pids"
mkdir -p "$LOG_DIR" "$PID_DIR"

# --- service registry --------------------------------------------------
# Parallel arrays (bash 3.2 on macOS has no associative arrays).
NODE_NAMES=(root intraday-service attendance-leave-service shift-marketplace-service \
  adherence-compliance-service analytics-reporting-service ai-layer-service \
  mobile-ess-service integration-hub-service)
NODE_DIRS=("$ROOT" "$ROOT/intraday-service" "$ROOT/attendance-leave-service" "$ROOT/shift-marketplace-service" \
  "$ROOT/adherence-compliance-service" "$ROOT/analytics-reporting-service" "$ROOT/ai-layer-service" \
  "$ROOT/mobile-ess-service" "$ROOT/integration-hub-service")
NODE_PORTS=(3000 8200 8300 8400 8500 8600 8700 8800 8900)

PY_NAMES=(forecasting-service scheduling-service)
PY_DIRS=("$ROOT/forecasting-service" "$ROOT/scheduling-service")
PY_PORTS=(8000 8100)

ALL_NAMES=("${NODE_NAMES[@]}" "${PY_NAMES[@]}" web-console)

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${BLUE}==>${NC} $*"; }
ok()    { echo -e "${GREEN}OK${NC}    $*"; }
warn()  { echo -e "${YELLOW}WARN${NC}  $*"; }
fail()  { echo -e "${RED}FAIL${NC}  $*"; }

pid_file() { echo "$PID_DIR/$1.pid"; }

is_running() {
  local pf; pf="$(pid_file "$1")"
  [[ -f "$pf" ]] && kill -0 "$(cat "$pf")" 2>/dev/null
}

# --- infra ---------------------------------------------------------------

start_infra() {
  info "Postgres + Redis (brew services)"
  brew services start postgresql@17 >/dev/null 2>&1 || true
  brew services start redis >/dev/null 2>&1 || true

  if lsof -i :4222 >/dev/null 2>&1; then
    ok "NATS JetStream already listening on :4222"
  elif command -v nats-server >/dev/null 2>&1; then
    info "Starting NATS JetStream (nats-server -js)"
    nohup nats-server -js >"$LOG_DIR/nats.log" 2>&1 &
    echo $! >"$(pid_file nats)"
    sleep 1
    ok "nats-server started (pid $(cat "$(pid_file nats)")), logs/nats.log"
  else
    warn "nats-server not installed (brew install nats-server) - event flows (notifications, marketplace, etc.) won't work, everything else still will"
  fi
}

# --- node services ---------------------------------------------------------
# Uses `npm --prefix <dir>` throughout instead of `cd`-ing into a subshell -
# keeps the recorded PID directly attached to npm's own process (nohup execs
# npm in place), no ambiguity from a cd+&& chain running inside a background
# subshell.

start_node_service() {
  local name="$1" dir="$2" port="$3"
  if is_running "$name"; then
    ok "$name already running (pid $(cat "$(pid_file "$name")"), :$port)"
    return
  fi

  if [[ ! -f "$dir/.env" && -f "$dir/.env.example" ]]; then
    cp "$dir/.env.example" "$dir/.env"
    warn "$name: no .env found, copied from .env.example"
  fi
  if [[ ! -d "$dir/node_modules" ]]; then
    info "$name: installing dependencies (first run, this takes a while)..."
    npm --prefix "$dir" ci --silent || { fail "$name: npm ci failed"; return 1; }
  fi

  info "$name: applying migrations"
  if ! npm --prefix "$dir" run --silent migration:run >"$LOG_DIR/$name.migrate.log" 2>&1; then
    fail "$name: migration:run failed - see logs/$name.migrate.log (did you run scripts/init-roles.sql once? see RUN.md step 2)"
    return 1
  fi

  info "Starting $name on :$port"
  nohup npm --prefix "$dir" run start:dev >"$LOG_DIR/$name.log" 2>&1 &
  echo $! >"$(pid_file "$name")"
  ok "$name started (pid $(cat "$(pid_file "$name")")), logs/$name.log"
}

# --- python services ---------------------------------------------------------

start_python_service() {
  local name="$1" dir="$2" port="$3"
  if is_running "$name"; then
    ok "$name already running (pid $(cat "$(pid_file "$name")"), :$port)"
  else
    if [[ ! -d "$dir/.venv" ]]; then
      fail "$name: no .venv found - see RUN.md step 5 for the one-time setup (scheduling-service needs a specific install order)"
      return 1
    fi
    if [[ ! -f "$dir/.env" && -f "$dir/.env.example" ]]; then
      cp "$dir/.env.example" "$dir/.env"
      warn "$name: no .env found, copied from .env.example"
    fi

    info "$name: applying migrations"
    (
      cd "$dir" || exit 1
      # shellcheck disable=SC1091
      source .venv/bin/activate
      alembic upgrade head
    ) >"$LOG_DIR/$name.migrate.log" 2>&1
    if [[ $? -ne 0 ]]; then
      fail "$name: alembic upgrade head failed - see logs/$name.migrate.log"
      return 1
    fi

    info "Starting $name on :$port"
    # exec at the tail of the subshell replaces the subshell's own process
    # with uvicorn, so the PID captured via $! after backgrounding is
    # uvicorn's real PID, not a wrapper shell's.
    (
      cd "$dir" || exit 1
      # shellcheck disable=SC1091
      source .venv/bin/activate
      exec uvicorn app.main:app --port "$port"
    ) >"$LOG_DIR/$name.log" 2>&1 &
    echo $! >"$(pid_file "$name")"
    ok "$name started (pid $(cat "$(pid_file "$name")")), logs/$name.log"
  fi

  if [[ "$name" == "scheduling-service" ]] && ! is_running "scheduling-service-worker"; then
    info "Starting scheduling-service worker (solves jobs the API process only enqueues)"
    (
      cd "$dir" || exit 1
      # shellcheck disable=SC1091
      source .venv/bin/activate
      exec python -m app.worker
    ) >"$LOG_DIR/scheduling-service-worker.log" 2>&1 &
    echo $! >"$(pid_file scheduling-service-worker)"
    ok "scheduling-service worker started (pid $(cat "$(pid_file scheduling-service-worker)")), logs/scheduling-service-worker.log"
  fi
}

# --- web-console ---------------------------------------------------------

start_web_console() {
  local name="web-console" dir="$ROOT/web-console" port=5173
  if is_running "$name"; then
    ok "$name already running (pid $(cat "$(pid_file "$name")"), :$port)"
    return
  fi
  if [[ ! -f "$dir/.env" && -f "$dir/.env.example" ]]; then
    cp "$dir/.env.example" "$dir/.env"
    warn "$name: no .env found, copied from .env.example"
  fi
  if [[ ! -d "$dir/node_modules" ]]; then
    info "$name: installing dependencies..."
    npm --prefix "$dir" ci --silent || { fail "$name: npm ci failed"; return 1; }
  fi
  info "Starting $name on :$port"
  nohup npm --prefix "$dir" run dev >"$LOG_DIR/$name.log" 2>&1 &
  echo $! >"$(pid_file "$name")"
  ok "$name started (pid $(cat "$(pid_file "$name")")), logs/$name.log"
}

# --- commands ---------------------------------------------------------

cmd_start() {
  local scope="${1:-all}"
  start_infra

  # Root first - other Node services' JWT verification and gRPC calls depend on it.
  start_node_service "root" "$ROOT" 3000

  if [[ "$scope" == "core" ]]; then
    echo
    info "Root-only mode. Run './dev.sh start' (no args) to bring up everything else."
    return
  fi
  sleep 2

  for i in "${!NODE_NAMES[@]}"; do
    [[ "${NODE_NAMES[$i]}" == "root" ]] && continue
    start_node_service "${NODE_NAMES[$i]}" "${NODE_DIRS[$i]}" "${NODE_PORTS[$i]}"
  done

  for i in "${!PY_NAMES[@]}"; do
    start_python_service "${PY_NAMES[$i]}" "${PY_DIRS[$i]}" "${PY_PORTS[$i]}"
  done

  start_web_console

  echo
  info "All services launched. 'root' + Python services need a few seconds to finish booting."
  echo "  root (Modules 01/02): http://localhost:3000  (REST /v1/*, /oauth/*, GraphQL /graphql, gRPC :5000)"
  echo "  web-console:           http://localhost:5173"
  echo "  forecasting-service:   http://localhost:8000"
  echo "  scheduling-service:    http://localhost:8100"
  for i in "${!NODE_NAMES[@]}"; do
    [[ "${NODE_NAMES[$i]}" == "root" ]] && continue
    printf "  %-22s http://localhost:%s\n" "${NODE_NAMES[$i]}:" "${NODE_PORTS[$i]}"
  done
  echo
  echo "  ./dev.sh status        - see what's up"
  echo "  ./dev.sh logs <name>   - tail one service's log"
  echo "  ./dev.sh stop          - stop everything"
}

cmd_stop() {
  info "Stopping all services started by this script"
  local any=0
  shopt -s nullglob
  for f in "$PID_DIR"/*.pid; do
    any=1
    local name pid pgid
    name="$(basename "$f" .pid)"
    pid="$(cat "$f")"
    if kill -0 "$pid" 2>/dev/null; then
      # SIGTERM the whole process group (npm/uvicorn/worker spawn children
      # that share the backgrounded job's pgid) rather than just the one PID.
      pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
      if [[ -n "$pgid" ]]; then
        kill -TERM "-$pgid" 2>/dev/null || kill "$pid" 2>/dev/null || true
      else
        kill "$pid" 2>/dev/null || true
      fi
      ok "stopped $name (pid $pid)"
    else
      warn "$name (pid $pid) was already stopped"
    fi
    rm -f "$f"
  done
  shopt -u nullglob
  [[ "$any" == 0 ]] && warn "nothing was running (no .pids/*.pid files found)"
  echo
  echo "Postgres/Redis were left running (brew services - shared with other work)."
  echo "Stop them yourself if you want to: brew services stop postgresql@17 && brew services stop redis"
}

cmd_status() {
  printf "%-28s %-8s %-6s\n" "SERVICE" "STATUS" "PID"
  for name in nats "${ALL_NAMES[@]}" scheduling-service-worker; do
    if is_running "$name"; then
      printf "%-28s ${GREEN}%-8s${NC} %-6s\n" "$name" "up" "$(cat "$(pid_file "$name")")"
    else
      printf "%-28s %-8s %-6s\n" "$name" "down" "-"
    fi
  done
}

cmd_logs() {
  if [[ -n "${1:-}" ]]; then
    tail -f "$LOG_DIR/$1.log"
  else
    tail -f "$LOG_DIR"/*.log
  fi
}

case "${1:-}" in
  start) cmd_start "${2:-all}" ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  logs) shift; cmd_logs "${1:-}" ;;
  *)
    echo "Usage: $0 {start [core]|stop|status|logs [service-name]}"
    exit 1
    ;;
esac
