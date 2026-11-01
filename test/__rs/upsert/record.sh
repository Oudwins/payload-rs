#!/usr/bin/env bash
# Records the write operations of upstream int suites into fixtures/<suite>.jsonl.gz.
# Usage: test/__rs/upsert/record.sh fields localization relationships ...
# UPSERT_MAX_OPS caps the recorded operations per suite (default 2500).
set -uo pipefail
cd "$(dirname "$0")/../../.."
mkdir -p test/__rs/upsert/fixtures
for suite in "$@"; do
  out="test/__rs/upsert/fixtures/${suite}.jsonl.gz"
  rm -f "$out"
  echo "== recording $suite -> $out"
  UPSERT_RECORD_OUT="$PWD/$out" UPSERT_MAX_OPS="${UPSERT_MAX_OPS:-2500}" \
    SQLITE_URL="${SQLITE_URL:-file:/tmp/rs-write-upsert.db}" TZ="${TZ:-UTC}" \
    PAYLOAD_DATABASE=sqlite DISABLE_LOGGING=true NODE_NO_WARNINGS=1 \
    NODE_OPTIONS="--no-deprecation --no-experimental-strip-types" \
    pnpm vitest run -c test/__rs/upsert/vitest.record.config.ts --project int "test/${suite}/int.spec.ts" 2>&1 | tail -n 8
  echo "   $(gzip -dc "$out" 2>/dev/null | wc -l) events, $(du -h "$out" | cut -f1)"
done
