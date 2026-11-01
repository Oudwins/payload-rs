#!/usr/bin/env bash
# Runs upstream int suites through test/__rs/sqlite/vitest.config.ts with the
# Rust client and with the real @libsql/client (same module graph), writing
# logs to /tmp/rs-sqlite-upstream/<suite>-<impl>[-tx].log.
# Usage: test/__rs/sqlite/run-upstream.sh hooks database fields ...
# PAYLOAD_SQLITE_TRANSACTIONS=1 runs with transactionOptions enabled (see
# transactionAdapter.ts); PAYLOAD_SQLITE_CLIENT_DEBUG=1 logs the client used and
# counts transaction() calls.
set -u
source /tmp/penv.sh
export PAYLOAD_DATABASE=sqlite TZ=UTC NODE_NO_WARNINGS=1 DISABLE_LOGGING=true NODE_OPTIONS="--no-deprecation --no-experimental-strip-types"
tag=$([ "${PAYLOAD_SQLITE_TRANSACTIONS:-}" = 1 ] && echo -tx || true)
mkdir -p /tmp/rs-sqlite-upstream
for suite in "$@"; do
  for impl in rs libsql; do
    log="/tmp/rs-sqlite-upstream/$suite-$impl$tag.log"
    count="/tmp/rs-sqlite-upstream/$suite-$impl$tag.transactions"
    rm -f "$count"
    PAYLOAD_SQLITE_TX_COUNT_FILE=$count SQLITE_URL=file:/tmp/rs-sqlite-upstream-$impl.db PAYLOAD_SQLITE_CLIENT=$impl \
      pnpm vitest run --config test/__rs/sqlite/vitest.config.ts "test/$suite/int.spec.ts" \
      > "$log" 2>&1
    echo "$suite $impl$tag: $(grep -E '^\s+Tests ' "$log" | tail -1) transaction() calls: $(cat "$count" 2>/dev/null || echo 0)"
  done
done
rm -f /tmp/rs-sqlite-upstream-rs.db* /tmp/rs-sqlite-upstream-libsql.db*
