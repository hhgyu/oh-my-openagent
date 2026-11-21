#!/usr/bin/env bash
set -eu

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$dir/common.sh"
root="$(mktemp -d)"
trap 'rm -rf -- "$root"' EXIT
export XDG_DATA_HOME="$root/fixture data"
unset OPENCODE_DB OQA_HAS_OPENCODE_DB
mkdir -p "$XDG_DATA_HOME/opencode"
sample="$XDG_DATA_HOME/opencode/qa fixture.db"
touch "$sample"

opencode() {
  case "$layout:$*" in
    v1:db\ path) printf '%s%s\n' "$sample" "$line_end" ;;
    v2:debug\ paths) printf 'data\t%s%s\n  db\t%s%s\n' "$XDG_DATA_HOME" "$line_end" "$sample" "$line_end" ;;
    *) return 1 ;;
  esac
}

expect_path() {
  local actual
  actual="$(oqa_db_path)"
  if [ "$actual" != "$1" ]; then
    printf 'expected %q, got %q\n' "$1" "$actual" >&2
    return 1
  fi
}

for layout in v1 v2; do
  for line_end in "" $'\r'; do
    expect_path "$sample"
  done
done
layout=missing
expect_path "$XDG_DATA_HOME/opencode/opencode.db"
OPENCODE_DB="sessions/custom.db" expect_path "$XDG_DATA_HOME/opencode/sessions/custom.db"
for absolute in "$sample" 'C:\Program Data\OpenCode\custom.db' 'C:/Program Data/OpenCode/custom.db' '\\server\share\custom.db' ':memory:'; do
  OPENCODE_DB="$absolute" expect_path "$absolute"
done
printf '%s\n' 'PASS: OpenCode DB path (1.x/2.x LF/CRLF, fallback, relative, absolute, memory)'
