#!/usr/bin/env bash
# common.sh - shared helpers for opencode-qa scripts.
#
# Source it from a sibling script:
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   . "$SCRIPT_DIR/lib/common.sh"
#
# SAFETY MODEL (read this):
#   - DB-read helpers (oqa_db_path / oqa_db_query) hit the LIVE opencode DB
#     READ-ONLY. That is safe and intended for session investigation.
#   - Anything that SPAWNS opencode (serve / run / tui) must run under an
#     ISOLATED XDG sandbox (oqa_mk_isolated_xdg) so QA never writes junk
#     sessions into the real ~/.local/share/opencode DB.
#   - oqa_cleanup runs on EXIT and tears down servers, tmux sessions, curl
#     watchers, and every temp dir created via the helpers.

# No `set -e`: these scripts deliberately probe failure paths (401, refused).
set -uo pipefail

SCRIPT_DIR_COMMON="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OQA_TMPDIRS=()
OQA_TMUX_SESSIONS=()
OQA_CURL_PIDS=()
OQA_SERVER_PID=""

oqa_log()  { printf '%s\n' "$*" >&2; }
oqa_pass() { printf 'PASS: %s\n' "$*"; }
oqa_fail() { printf 'FAIL: %s\n' "$*" >&2; return 1; }

# oqa_require <bin>...  -> 0 if all present, else 1 (names the missing ones).
oqa_require() {
  local missing=0 b
  for b in "$@"; do
    if ! command -v "$b" >/dev/null 2>&1; then
      oqa_log "missing dependency: $b"
      missing=1
    fi
  done
  return "$missing"
}

# 0 when the installed opencode has the 1.x `db` subcommand. OpenCode 2.x has
# none: `opencode db path` prints the top-level help instead of a file path.
oqa_has_opencode_db() {
  if [ -z "${OQA_HAS_OPENCODE_DB:-}" ]; then
    local probe
    probe="$(opencode db path 2>/dev/null | head -1)"
    if [ -n "$probe" ] && [ -f "$probe" ]; then OQA_HAS_OPENCODE_DB=1; else OQA_HAS_OPENCODE_DB=0; fi
  fi
  [ "$OQA_HAS_OPENCODE_DB" = 1 ]
}

# Absolute path of the active opencode DB. Order: OPENCODE_DB, the 1.x
# `opencode db path`, the 2.x `opencode debug paths` db line, the XDG default.
oqa_db_path() {
  if [ -n "${OPENCODE_DB:-}" ]; then printf '%s\n' "$OPENCODE_DB"; return 0; fi
  local p
  if oqa_has_opencode_db; then
    opencode db path 2>/dev/null | head -1; return 0
  fi
  p="$(opencode debug paths 2>/dev/null | awk '$1 == "db" { sub(/^db[ \t]+/, ""); print; exit }')"
  if [ -n "$p" ]; then printf '%s\n' "$p"; return 0; fi
  printf '%s\n' "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db"
}

# Escape a value for safe embedding inside a single-quoted SQL literal.
oqa_sql_escape() {
  printf '%s' "$1" | sed "s/'/''/g"
}

oqa_db_runtime() {
  if command -v node >/dev/null 2>&1 && node -e 'require("node:sqlite")' >/dev/null 2>&1; then
    echo node; return 0
  fi
  if command -v bun >/dev/null 2>&1; then echo bun; return 0; fi
  return 1
}

# Run a read-only SQL query against the active DB; emit JSON rows.
# Usage: oqa_db_query "SELECT ... LIMIT 5"
# 1.x: `opencode db --format json`. 2.x: lib/db-query.mjs, which opens the DB
# read-only with PRAGMA query_only.
oqa_db_query() {
  if oqa_has_opencode_db; then
    opencode db "$1" --format json 2>/dev/null; return
  fi
  if [ -z "${OQA_DB_RUNTIME:-}" ]; then
    OQA_DB_RUNTIME="$(oqa_db_runtime)" || { oqa_log "missing dependency: node>=22.5 (node:sqlite) or bun"; return 1; }
  fi
  if [ -z "${OQA_DB_FILE:-}" ]; then OQA_DB_FILE="$(oqa_db_path)"; fi
  if [ "$OQA_DB_RUNTIME" = node ]; then
    node --no-warnings "$SCRIPT_DIR_COMMON/db-query.mjs" "$OQA_DB_FILE" "$1"
  else
    bun "$SCRIPT_DIR_COMMON/db-query.mjs" "$OQA_DB_FILE" "$1"
  fi
}

# Storage layout of the active DB: `v2` (OpenCode 2.x: session_v2 +
# session_message) or `v1` (session + message/part).
oqa_db_layout() {
  if [ -z "${OQA_DB_LAYOUT:-}" ]; then
    local n
    n="$(oqa_db_query "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('session_v2','session_message')" | jq -r '.[0].n // 0' 2>/dev/null)"
    if [ "${n:-0}" = 2 ]; then OQA_DB_LAYOUT=v2; else OQA_DB_LAYOUT=v1; fi
  fi
  echo "$OQA_DB_LAYOUT"
}

oqa_session_table() {
  if [ "$(oqa_db_layout)" = v2 ]; then echo session_v2; else echo session; fi
}

# Preserve HOME-based opencode shims after HOME is sandboxed. Some installed
# opencode wrappers resolve the real binary via "$HOME/.opencode/bin/opencode";
# after oqa_mk_isolated_xdg rewrites HOME, that path must still exist.
oqa_preserve_home_opencode_bin() {
  local real_home="$1" sandbox_home="$2"
  [ -d "$real_home/.opencode/bin" ] || return 0
  mkdir -p "$sandbox_home/.opencode" || return 1
  ln -s "$real_home/.opencode/bin" "$sandbox_home/.opencode/bin" 2>/dev/null || return 1
}

# Create an isolated XDG sandbox so a spawned opencode never touches the real
# DB. Sets globals OQA_XDG_ROOT + OQA_PROJ and exports XDG_*; registers the
# root for cleanup.
#
# IMPORTANT: call this DIRECTLY, never via $(...). Command substitution runs in
# a subshell, which would discard the exports and the cleanup registration.
#   oqa_mk_isolated_xdg            # good
#   root="$OQA_XDG_ROOT"           # read the global afterwards
oqa_mk_isolated_xdg() {
  local root real_home
  root="$(mktemp -d -t oqa-xdg.XXXXXX)" || return 1
  real_home="$HOME"
  OQA_TMPDIRS+=("$root")
  mkdir -p "$root/data" "$root/config" "$root/cache" "$root/state" "$root/home" "$root/proj"
  oqa_preserve_home_opencode_bin "$real_home" "$root/home" || return 1
  export OQA_XDG_ROOT="$root"
  export HOME="$root/home"
  export OPENCODE_TEST_HOME="$root/home"
  export XDG_DATA_HOME="$root/data"
  export XDG_CONFIG_HOME="$root/config"
  export XDG_CACHE_HOME="$root/cache"
  export XDG_STATE_HOME="$root/state"
  export OQA_PROJ="$root/proj"
  # keep the sandbox offline + fast
  export OPENCODE_DISABLE_AUTOUPDATE=1
  export OPENCODE_DISABLE_MODELS_FETCH=1
}

# Print a free TCP port on 127.0.0.1.
oqa_free_port() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
  elif command -v bun >/dev/null 2>&1; then
    bun -e 'const s=Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(){}}});console.log(s.port);s.stop()'
  else
    # last resort: a high random port (small race window)
    printf '%s' "$(( (RANDOM % 20000) + 40000 ))"
  fi
}

# Poll an HTTP url until it accepts a connection (any status) or times out.
# Usage: oqa_wait_http <url> [user:pass] [timeout_s]
oqa_wait_http() {
  local url="$1" auth="${2:-}" timeout="${3:-25}" deadline
  deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -n "$auth" ]; then
      curl -s -o /dev/null -u "$auth" "$url" && return 0
    else
      curl -s -o /dev/null "$url" && return 0
    fi
    sleep 0.2
  done
  return 1
}

# Start an isolated, password-protected headless server.
# Sets globals OQA_SERVER_URL / OQA_SERVER_PASS / OQA_SERVER_PORT / OQA_SERVER_PID.
# Returns 1 if it never becomes ready.
#
# IMPORTANT: call this DIRECTLY, never via $(...). The PID + exports must land
# in the caller's shell so oqa_cleanup can kill the server on exit.
#   oqa_start_server || { oqa_log "no server"; exit 1; }
#   url="$OQA_SERVER_URL"
oqa_start_server() {
  oqa_mk_isolated_xdg || return 1
  oqa_launch_server "$XDG_STATE_HOME/serve.log" "$XDG_STATE_HOME/serve.log"
}

# Native path for a non-MSYS child (bun on Windows cannot read /c/... paths).
oqa_native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

# The driver's OS pid: on MSYS/Git Bash $$ is an MSYS pid, the guard needs the
# Windows one.
oqa_driver_os_pid() {
  if [ -r "/proc/$$/winpid" ]; then cat "/proc/$$/winpid"; else printf '%s' "$$"; fi
}

# oqa_guarded_spawn <pid-file> <command> [args...]   (run it with `&`)
# Every long-lived QA child (above all `opencode serve`) MUST start through
# serve-guard.mjs: Windows kill-on-close Job Object / POSIX process group, plus
# a parent-pid watch, so the child dies with the driver even when the driver is
# SIGKILLed or `taskkill /F`ed and its EXIT trap never runs.
oqa_guarded_spawn() {
  local pid_file="$1"; shift
  exec bun "$(oqa_native_path "$SCRIPT_DIR_COMMON/serve-guard.mjs")" \
    --parent-pid "$(oqa_driver_os_pid)" --pid-file "$(oqa_native_path "$pid_file")" -- "$@"
}

# Launch an isolated, password-protected server in the CURRENT XDG sandbox
# (call oqa_mk_isolated_xdg first). Args: stdout_log stderr_log.
# Sets OQA_SERVER_URL / OQA_SERVER_PASS / OQA_SERVER_PORT / OQA_SERVER_PID
# (the guard pid) / OQA_SERVER_CHILD_PID_FILE. Call DIRECTLY, never via $(...).
oqa_launch_server() {
  local out_log="$1" err_log="$2" port pass
  oqa_require bun || return 1
  port="$(oqa_free_port)"
  pass="oqa-${RANDOM}${RANDOM}"
  OQA_SERVER_CHILD_PID_FILE="$XDG_STATE_HOME/serve.child.pid"
  if [ "$out_log" = "$err_log" ]; then
    ( OPENCODE_SERVER_PASSWORD="$pass" oqa_guarded_spawn "$OQA_SERVER_CHILD_PID_FILE" \
        opencode serve --port "$port" --hostname 127.0.0.1 ) >"$out_log" 2>&1 &
  else
    ( OPENCODE_SERVER_PASSWORD="$pass" oqa_guarded_spawn "$OQA_SERVER_CHILD_PID_FILE" \
        opencode serve --port "$port" --hostname 127.0.0.1 ) >"$out_log" 2>"$err_log" &
  fi
  OQA_SERVER_PID=$!
  disown "$OQA_SERVER_PID" 2>/dev/null || true
  export OQA_SERVER_PORT="$port"
  export OQA_SERVER_PASS="$pass"
  export OQA_SERVER_URL="http://127.0.0.1:$port"
  if ! oqa_wait_http "$OQA_SERVER_URL/global/health" "opencode:$pass" 30; then
    oqa_log "server failed to start; log follows:"
    cat "$out_log" >&2 2>/dev/null || true
    [ "$out_log" = "$err_log" ] || cat "$err_log" >&2 2>/dev/null || true
    return 1
  fi
}

# Stop the guarded server tree. Killing the guard closes the Windows job (the
# kernel kills every process in it); on POSIX the guard kills the child's
# process group, and the recorded pgid covers a guard that already died.
oqa_stop_server() {
  local child_pid=""
  [ -n "${OQA_SERVER_CHILD_PID_FILE:-}" ] && child_pid="$(tr -d '[:space:]' <"$OQA_SERVER_CHILD_PID_FILE" 2>/dev/null)"
  if [ -n "${OQA_SERVER_PID:-}" ]; then
    kill "$OQA_SERVER_PID" 2>/dev/null || true
    local tries=0
    while kill -0 "$OQA_SERVER_PID" 2>/dev/null && [ "$tries" -lt 30 ]; do sleep 0.1; tries=$((tries+1)); done
    kill -0 "$OQA_SERVER_PID" 2>/dev/null && kill -9 "$OQA_SERVER_PID" 2>/dev/null || true
    OQA_SERVER_PID=""
  fi
  case "$child_pid" in
    ''|*[!0-9]*) ;;
    *) [ -r /proc/$$/winpid ] || kill -9 -- "-$child_pid" 2>/dev/null || true ;;
  esac
  OQA_SERVER_CHILD_PID_FILE=""
}

# Teardown everything the helpers created. Safe to call multiple times.
oqa_cleanup() {
  oqa_stop_server
  local s p d
  for s in "${OQA_TMUX_SESSIONS[@]:-}"; do
    [ -n "$s" ] && tmux kill-session -t "$s" 2>/dev/null || true
  done
  for p in "${OQA_CURL_PIDS[@]:-}"; do
    [ -n "$p" ] && kill "$p" 2>/dev/null || true
    [ -n "$p" ] && sleep 0.1
    [ -n "$p" ] && kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null || true
  done
  for d in "${OQA_TMPDIRS[@]:-}"; do
    [ -n "$d" ] && rm -rf "$d" 2>/dev/null || true
  done
  OQA_TMPDIRS=()
  OQA_TMUX_SESSIONS=()
  OQA_CURL_PIDS=()
}
trap oqa_cleanup EXIT

# ---- orphan check ------------------------------------------------------------
# Kill whatever still listens on 127.0.0.1:<port> (self-test hygiene only, so a
# failing orphan check never leaves the orphan it detected behind).
oqa__reap_port_listener() {
  local port="$1" pid
  if command -v netstat >/dev/null 2>&1 && command -v taskkill >/dev/null 2>&1; then
    for pid in $(netstat -ano 2>/dev/null | awk -v p=":$port" '$2 ~ p"$" && $4 == "LISTENING" {print $5}' | sort -u); do
      oqa_log "reaping orphaned listener pid $pid on port $port"
      MSYS2_ARG_CONV_EXCL='*' taskkill /T /F /PID "$pid" >/dev/null 2>&1 || true
    done
  elif command -v lsof >/dev/null 2>&1; then
    for pid in $(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null); do
      oqa_log "reaping orphaned listener pid $pid on port $port"
      kill -9 "$pid" 2>/dev/null || true
    done
  fi
}

# oqa_assert_no_orphan_after_forced_kill
# Starts a driver shell that brings a server up through oqa_start_server, then
# SIGKILLs that driver so its EXIT trap never runs (the way an agent's shell or
# tool timeout dies). The server must stop on its own within 20s.
oqa_assert_no_orphan_after_forced_kill() {
  local marker driver_pid port="" root="" deadline alive=1
  marker="$(mktemp -t oqa-orphan.XXXXXX)"
  bash -c '
    . "'"$SCRIPT_DIR_COMMON"'/common.sh"
    oqa_start_server || exit 1
    printf "%s\n%s\n" "$OQA_SERVER_PORT" "$OQA_XDG_ROOT" > "'"$marker"'"
    while :; do sleep 1; done
  ' >/dev/null 2>&1 &
  driver_pid=$!
  deadline=$(( $(date +%s) + 60 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    port="$(sed -n '1p' "$marker" 2>/dev/null)"
    [ -n "$port" ] && break
    kill -0 "$driver_pid" 2>/dev/null || break
    sleep 0.2
  done
  root="$(sed -n '2p' "$marker" 2>/dev/null)"
  rm -f "$marker"
  if [ -z "$port" ]; then
    kill -9 "$driver_pid" 2>/dev/null || true
    oqa_log "FAIL: forced-kill driver never brought a server up"
    return 1
  fi
  kill -9 "$driver_pid" 2>/dev/null || true
  wait "$driver_pid" 2>/dev/null || true
  deadline=$(( $(date +%s) + 20 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if ! curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$port/global/health"; then
      alive=0
      break
    fi
    sleep 0.25
  done
  [ -n "$root" ] && rm -rf "$root" 2>/dev/null
  if [ "$alive" -eq 0 ]; then
    oqa_pass "no opencode server survives a forced (SIGKILL) driver kill (port $port closed)"
    return 0
  fi
  oqa_log "FAIL: opencode server on port $port outlived its SIGKILLed driver"
  oqa__reap_port_listener "$port"
  return 1
}

# ---- self-check ------------------------------------------------------------
# Run: bash scripts/lib/common.sh --self-check
oqa__self_check() {
  local fails=0

  if oqa_require opencode sqlite3 curl jq tmux; then
    oqa_pass "dependencies present (opencode sqlite3 curl jq tmux)"
  else
    oqa_log "FAIL: missing dependencies"; fails=$((fails+1))
  fi

  local dbp; dbp="$(oqa_db_path)"
  if [ -n "$dbp" ] && [ -f "$dbp" ]; then
    oqa_pass "oqa_db_path -> $dbp"
  else
    oqa_log "FAIL: oqa_db_path returned '$dbp'"; fails=$((fails+1))
  fi

  local layout table sessions
  layout="$(oqa_db_layout)"; table="$(oqa_session_table)"
  sessions="$(oqa_db_query "SELECT count(*) AS n FROM $table" | jq -r '.[0].n // empty' 2>/dev/null)"
  if [ "${sessions:-0}" -ge 1 ] 2>/dev/null; then
    oqa_pass "oqa_db_query reads $sessions row(s) from $table (layout $layout)"
  else
    oqa_log "FAIL: oqa_db_query on $table (layout $layout) returned '$sessions'"; fails=$((fails+1))
  fi

  if ! oqa_has_opencode_db; then
    if oqa_db_query "DELETE FROM $table WHERE 0" >/dev/null 2>&1; then
      oqa_log "FAIL: db-query.mjs accepted a write statement"; fails=$((fails+1))
    else
      oqa_pass "db-query.mjs refuses write statements"
    fi
  fi

  local esc; esc="$(oqa_sql_escape "a'b'c")"
  if [ "$esc" = "a''b''c" ]; then
    oqa_pass "oqa_sql_escape quotes single quotes"
  else
    oqa_log "FAIL: oqa_sql_escape -> '$esc'"; fails=$((fails+1))
  fi

  local port; port="$(oqa_free_port)"
  if [ "$port" -gt 0 ] 2>/dev/null; then
    oqa_pass "oqa_free_port -> $port"
  else
    oqa_log "FAIL: oqa_free_port -> '$port'"; fails=$((fails+1))
  fi

  # isolation + trap teardown: an inner shell creates a sandbox (calling the
  # helper DIRECTLY so the cleanup registration survives) and exits; the EXIT
  # trap must remove it. We pass the sandbox path out via a marker file.
  local marker isodir home test_home
  marker="$(mktemp -t oqa-marker.XXXXXX)"
  bash -c '. "'"${BASH_SOURCE[0]}"'"; oqa_mk_isolated_xdg; printf "%s\n%s\n%s\n" "$OQA_XDG_ROOT" "$HOME" "$OPENCODE_TEST_HOME" > "'"$marker"'"'
  isodir="$(sed -n '1p' "$marker" 2>/dev/null)"
  home="$(sed -n '2p' "$marker" 2>/dev/null)"
  test_home="$(sed -n '3p' "$marker" 2>/dev/null)"
  rm -f "$marker"
  if [ -n "$isodir" ] && [ ! -d "$isodir" ]; then
    oqa_pass "isolated XDG sandbox auto-removed on exit ($isodir)"
  else
    oqa_log "FAIL: sandbox not cleaned: '$isodir' (exists=$([ -d "$isodir" ] && echo yes || echo no))"; fails=$((fails+1))
  fi
  if [ -n "$isodir" ] && [ "$home" = "$isodir/home" ] && [ "$test_home" = "$isodir/home" ]; then
    oqa_pass "isolated HOME points inside sandbox"
  else
    oqa_log "FAIL: sandbox HOME not isolated (HOME='$home' OPENCODE_TEST_HOME='$test_home' root='$isodir')"; fails=$((fails+1))
  fi

  local shim_marker shim_result
  shim_marker="$(mktemp -t oqa-shim.XXXXXX)"
  bash -c '
    set -u
    . "'"${BASH_SOURCE[0]}"'"
    fake_home="$(mktemp -d -t oqa-fake-home.XXXXXX)"
    mkdir -p "$fake_home/.local/bin" "$fake_home/.opencode/bin"
    printf "%s\n" "#!/usr/bin/env bash" "exec \"\$HOME/.opencode/bin/opencode\" \"\$@\"" > "$fake_home/.local/bin/opencode"
    printf "%s\n" "#!/usr/bin/env bash" "exec \"\$HOME/.opencode/bin/opencode-real\" \"\$@\"" > "$fake_home/.opencode/bin/opencode"
    printf "%s\n" "#!/usr/bin/env bash" "printf fake-opencode-ok" > "$fake_home/.opencode/bin/opencode-real"
    chmod +x "$fake_home/.local/bin/opencode" "$fake_home/.opencode/bin/opencode" "$fake_home/.opencode/bin/opencode-real"
    HOME="$fake_home"
    PATH="$fake_home/.local/bin:$PATH"
    oqa_mk_isolated_xdg
    opencode > "'"$shim_marker"'"
    oqa_cleanup
    rm -rf "$fake_home"
  '
  shim_result="$(cat "$shim_marker" 2>/dev/null)"
  rm -f "$shim_marker"
  if [ "$shim_result" = "fake-opencode-ok" ]; then
    oqa_pass "isolated HOME preserves HOME-based opencode shim"
  else
    oqa_log "FAIL: HOME-based opencode shim returned '$shim_result'"; fails=$((fails+1))
  fi

  oqa_assert_no_orphan_after_forced_kill || fails=$((fails+1))

  if [ "$fails" -eq 0 ]; then
    oqa_pass "common.sh self-check"
    return 0
  fi
  oqa_log "common.sh self-check had $fails failure(s)"
  return 1
}

if [ "${1:-}" = "--self-check" ]; then
  oqa__self_check
  exit $?
fi
