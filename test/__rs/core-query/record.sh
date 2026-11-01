#!/usr/bin/env bash
# Records query/select utility calls of upstream int suites into fixtures/<suite>.jsonl.
# Usage: test/__rs/core-query/record.sh fields relationships localization ...
#
# Each suite's full vitest output goes to fixtures/<suite>.log. The script prints the vitest
# summary, every failed test, unhandled error and recorder drop count, and exits non-zero when a
# suite failed, reported unhandled errors, or recorded no calls (a fixture of a failing run would
# silently replay a different corpus).
set -uo pipefail
cd "$(dirname "$0")/../../.."
mkdir -p test/__rs/core-query/fixtures
status=0
for suite in "$@"; do
  # a suite name (test/<suite>/int.spec.ts) or a spec path relative to test/ without .int.spec.ts
  spec="test/${suite}/int.spec.ts"
  [ -f "$spec" ] || spec="test/${suite}.int.spec.ts"
  name="$(basename "$suite")"
  out="test/__rs/core-query/fixtures/${name}.jsonl"
  log="test/__rs/core-query/fixtures/${name}.log"
  rm -f "$out"
  echo "== recording $suite -> $out"
  RS_CORE_QUERY_OUT="$PWD/$out" TZ="${TZ:-UTC}" \
    SQLITE_URL="${SQLITE_URL:-file:/tmp/rs-core-query.db}" \
    PAYLOAD_DATABASE=sqlite DISABLE_LOGGING=true NODE_NO_WARNINGS=1 \
    NODE_OPTIONS="--no-deprecation --no-experimental-strip-types" \
    pnpm vitest run -c test/__rs/core-query/vitest.record.config.ts --project int "$spec" > "$log" 2>&1
  vitest_status=$?
  grep -E "^ *(Test Files|Tests|Errors) |  FAIL | ✗ | × |Unhandled|\[core-query recorder\]" "$log" | sed 's/^/   /'
  # grep -c prints 0 (and exits 1) when nothing matches, and nothing when the file is missing.
  calls=$(grep -c '"type":"call"' "$out" 2>/dev/null || true)
  calls=${calls:-0}
  echo "   ${calls} calls, $(du -h "$out" 2>/dev/null | cut -f1)"
  if [ "$vitest_status" -ne 0 ]; then
    echo "   FAILED: vitest exited with $vitest_status (see $log)" >&2
    status=1
  fi
  if grep -qE "Unhandled (Rejection|Error)" "$log"; then
    echo "   FAILED: unhandled errors during the run (see $log)" >&2
    status=1
  fi
  if [ "$calls" -eq 0 ]; then
    echo "   FAILED: no calls recorded" >&2
    status=1
  fi
  rm -f /tmp/rs-core-query.db*
done
exit $status
