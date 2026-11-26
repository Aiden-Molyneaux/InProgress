#!/usr/bin/env bash
# The exam (plan task 16), from stage 0's run.sh. usage: run.sh <out dir> <half file> [parallel]
# <out dir> holds cases.mjs's files. Environment: EXAM_COPY (the copy of the data), EXAM_BUILD (the build dir, default
# .build/exam in the repo); INPROGRESS_LEAD_CLAUDE names the program a lead turn runs (default claude).
# Phases: the lead on every case (task 4's runner, blind, the record cut off at the asking, one port per lane from 4410);
# two labellers on every key file (Opus and Sonnet, label-v2.md, no tools); the answer judge on every case the lead decided.
# Skips anything already done.
P="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$P/../.." && pwd)"
O="$(cd "$1" && pwd)"
H="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
N="${3:-4}"
[ "$N" -gt 10 ] && N=10
BUILD="${EXAM_BUILD:-$REPO/.build/exam}"
LABEL="${LABEL_FILE:-label-v2.md}"
[ -n "$EXAM_COPY" ] || { echo "set EXAM_COPY to the copy of the data" >&2; exit 2; }
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
