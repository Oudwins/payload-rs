#!/usr/bin/env bash
# Runs in-process core differential spec files (test/__rs/core-runtime, core-hooks-*, core-query
# synthetic, ...) on MongoDB through test/__rs/core-mongo/vitest.config.ts (the shared generated
# test/databaseAdapter.js is never written), each file on its own database, dropped afterwards.
# The TS reference must be upstream TS: PAYLOAD_ENGINE / PAYLOAD_CORE_ENGINE are unset.
#
#   PAYLOAD_ENGINE_ADDON=/tmp/coremongo-addon/payload-engine.node \
#     test/__rs/core-mongo/runDifferentials.sh test/__rs/core-runtime/synthetic.int.spec.ts ...
#
# OUT (default /tmp/coremongo-runs/diff): <slug>.log and <slug>.json (vitest JSON) per file.
# Exits 1 when a file fails, has no report or ran zero tests.
set -u
source /tmp/penv.sh
cd "$(dirname "$0")/../../.."
export PAYLOAD_ENGINE=ts # upstream TS (unset selects Rust)
unset PAYLOAD_CORE_ENGINE DATABASE_URL
# RS_ORDERED_IO: database results are delivered in call order (test/__rs/dispatch/settle.ts), so
# concurrent work that queries the database interleaves the same way in every run.
export RS_ORDERED_IO=${RS_ORDERED_IO:-true}
export PAYLOAD_DATABASE=mongodb NODE_NO_WARNINGS=1 DISABLE_LOGGING=true \
  NODE_OPTIONS="--no-deprecation --no-experimental-strip-types" TZ=${TZ:-UTC}
OUT=${OUT:-/tmp/coremongo-runs/diff}
mkdir -p "$OUT"
status=0
for spec in "$@"; do
  slug=$(echo "$spec" | sed 's#^test/__rs/##; s#\.int\.spec\.ts$##; s#[^a-zA-Z0-9]#_#g')
  db="cmdiff_${slug}_$$"
  MONGODB_URL="$(node test/__rs/core-mongo/db.mjs url "$db")" \
    pnpm vitest run --config test/__rs/core-mongo/vitest.config.ts --project int "$spec" \
    --reporter=default --reporter=json --outputFile.json="$OUT/$slug.json" > "$OUT/$slug.log" 2>&1
  node test/__rs/core-mongo/db.mjs drop "$db"
  summary=$(node -e 'const r=require(process.argv[1]);if(!r.numTotalTests)process.exit(3);console.log(`passed ${r.numPassedTests} failed ${r.numFailedTests} pending ${r.numPendingTests+r.numTodoTests}`);process.exit(r.numFailedTests?4:0)' "$OUT/$slug.json" 2>/dev/null) || { status=1; summary="${summary:-no report or zero tests} FAIL"; }
  echo "$spec: $summary $(grep -oE '^\[core-[a-z -]+\].*' "$OUT/$slug.log" | sed -E 's/(callbackCalls=[0-9]+) \{[^}]*\}/\1/; s/(rejections=[0-9]+) \{[^}]*\}/\1/' | tr '\n' ';' | cut -c1-600)"
done
exit $status
