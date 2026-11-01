#!/usr/bin/env bash
# Records query/select utility calls of upstream int suites into fixtures/<suite>.jsonl.
# Usage: test/__rs/core-query/record.sh fields relationships localization ...
set -uo pipefail
cd "$(dirname "$0")/../../.."
mkdir -p test/__rs/core-query/fixtures
for suite in "$@"; do
  # a suite name (test/<suite>/int.spec.ts) or a spec path relative to test/ without .int.spec.ts
  spec="test/${suite}/int.spec.ts"
  [ -f "$spec" ] || spec="test/${suite}.int.spec.ts"
  out="test/__rs/core-query/fixtures/$(basename "$suite").jsonl"
  rm -f "$out"
  echo "== recording $suite -> $out"
  RS_CORE_QUERY_OUT="$PWD/$out" TZ="${TZ:-UTC}" \
    SQLITE_URL="${SQLITE_URL:-file:/tmp/rs-core-query.db}" \
    PAYLOAD_DATABASE=sqlite DISABLE_LOGGING=true NODE_NO_WARNINGS=1 \
    NODE_OPTIONS="--no-deprecation --no-experimental-strip-types" \
    pnpm vitest run -c test/__rs/core-query/vitest.record.config.ts --project int "$spec" 2>&1 | grep -E "^ *(Test Files|Tests ) | FAIL "
  echo "   $(grep -c '"type":"call"' "$out" 2>/dev/null || echo 0) calls, $(du -h "$out" 2>/dev/null | cut -f1)"
  rm -f /tmp/rs-core-query.db*
done
