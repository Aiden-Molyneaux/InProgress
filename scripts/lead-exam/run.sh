#!/usr/bin/env bash
# The exam (plan task 16), from stage 0's run.sh. usage: run.sh [--no-labels] <out dir> <half file> [parallel]
# <out dir> holds cases.mjs's files. Environment: EXAM_COPY (the copy of the data), EXAM_BUILD (the build dir, default
# .build/exam in the repo); INPROGRESS_LEAD_CLAUDE names the program a lead turn runs (default claude).
# Phases: the lead on every case (task 4's runner, blind, the record cut off at the asking, one port per lane from 4410);
# two labellers on every key file (Opus and Sonnet, label-v2.md, no tools); the answer judge on every case the lead decided.
# Skips anything already done. WARNING: the lead turns, the labellers and the judge all run the REAL claude and spend real
# turns (unless INPROGRESS_LEAD_CLAUDE is a stand-in, which covers the lead phase only). --no-labels runs the lead phase
# only: no labeller, no judge, no scoring.
P="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$P/../.." && pwd)"
LABELS=1
if [ "$1" = "--no-labels" ]; then LABELS=0; shift; fi
[ -d "$1" ] || { echo "usage: run.sh [--no-labels] <out dir> <half file> [parallel]: $1 is not a folder" >&2; exit 2; }
[ -f "$2" ] || { echo "usage: run.sh [--no-labels] <out dir> <half file> [parallel]: $2 is not a file" >&2; exit 2; }
O="$(cd "$1" && pwd)"
H="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
N="${3:-4}"
case "$N" in '' | *[!0-9]*) N=4 ;; esac
if [ "$N" -lt 1 ] || [ "$N" -gt 10 ]; then N=4; fi
# Absolute before the cd below.
BUILD="$(cd "${EXAM_BUILD:-$REPO/.build/exam}" 2>/dev/null && pwd)" || { echo "the build dir ${EXAM_BUILD:-$REPO/.build/exam} is not a folder" >&2; exit 2; }
[ -n "$EXAM_COPY" ] && [ -f "$EXAM_COPY" ] || { echo "set EXAM_COPY to the copy of the data (a file)" >&2; exit 2; }
EXAM_COPY="$(cd "$(dirname "$EXAM_COPY")" && pwd)/$(basename "$EXAM_COPY")"
# Before anything is made: neither the out dir nor the copy may lie under the live home (exit 2).
node "$P/guard-cli.mjs" "$O" "$EXAM_COPY" || exit 2
LABEL="${LABEL_FILE:-label-v2.md}"
unset CLAUDECODE CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ID CLAUDE_PID CLAUDE_EFFORT CLAUDE_CODE_MESSAGING_SOCKET
unset CLAUDE_AGENT_SDK_VERSION CLAUDE_CODE_SESSION_ATTENDED CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_EXECPATH CLAUDE_CODE_MESSAGING_TOKEN
unset T3CODE_THREAD_ID T3CODE_CLI_PATH
D="$O/labeller"
mkdir -p "$D/cwd"
[ -f "$D/settings.json" ] || echo '{}' > "$D/settings.json"
cd "$D/cwd" || exit 2

ok() {
  [ -s "$1" ] && grep -q "\"result\"" "$1"
}

# plain <model> <system file> <input> <output>
plain() {
  ok "$4" && return 0
  claude -p --model "$1" --system-prompt-file "$2" --settings "$D/settings.json" --setting-sources project \
    --strict-mcp-config --tools "" --output-format json --max-turns 1 --no-session-persistence \
    < "$3" > "$4" 2> "$4.err"
}

# Phase 1: the lead. One lane per port (4410 + lane); a lane runs its cases one after the other.
lane() {
  local lane="$1" i=0 k id project before
  while read -r k id project before; do
    [ -z "$k" ] && continue
    if [ $((i % N)) -eq "$lane" ]; then
      node "$P/run-case.mjs" "$BUILD" "$EXAM_COPY" "$O" "$k" "$id" $((4410 + lane)) || echo "case $k-$id failed" >&2
    fi
    i=$((i + 1))
  done < "$H"
}
for ((l = 0; l < N; l++)); do lane "$l" & done
wait

if [ "$LABELS" -eq 0 ]; then exit 0; fi

# Phase 2: the two labellers, N at a time.
n=0
gate() {
  n=$((n + 1))
  if [ $((n % N)) -eq 0 ]; then wait; fi
}
while read -r k id project before; do
  [ -z "$k" ] && continue
  plain opus "$P/$LABEL" "$O/$k-$id.key.md" "$O/labelA-$k-$id.json" &
  gate
  plain sonnet "$P/$LABEL" "$O/$k-$id.key.md" "$O/labelB-$k-$id.json" &
  gate
done < "$H"
wait

# Phase 3: the answer judge on every case the lead decided.
node "$P/score.mjs" "$O" "$H" --write-judge-inputs
while read -r k id project before; do
  [ -z "$k" ] && continue
  if [ -f "$O/judgein-$k-$id.md" ]; then
    plain opus "$P/judge-answer.md" "$O/judgein-$k-$id.md" "$O/judge-$k-$id.json" &
    gate
  fi
done < "$H"
wait

node "$P/score.mjs" "$O" "$H"
