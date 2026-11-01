#!/usr/bin/env bash
# Runs upstream int suites through test/__rs/core-validate/vitest.config.ts with the Rust-backed
# validators (`rs`) and with the upstream module (`ts`, same config), writing vitest JSON reports
# to $OUT/<suite>-<impl>-<tz>.json and comparing per-test outcomes with compare.mjs.
# Usage: PAYLOAD_ENGINE_ADDON=/tmp/x.node test/__rs/core-validate/run-upstream.sh validate fields auth
# IMPLS="rs" / TZS="UTC Europe/Lisbon" restrict the matrix (defaults: "ts rs", "UTC").
set -u
source /tmp/penv.sh
export PAYLOAD_DATABASE=sqlite NODE_NO_WARNINGS=1 DISABLE_LOGGING=true NODE_OPTIONS="--no-deprecation --no-experimental-strip-types"
OUT=${OUT:-/tmp/rs-validate-host}
DB=${DB:-/tmp/rs-validate-host.db}
mkdir -p "$OUT"
for suite in "$@"; do
  for tz in ${TZS:-UTC}; do
    tztag=$(echo "$tz" | tr '/' '_')
    for impl in ${IMPLS:-ts rs}; do
      rm -f "$DB" "$DB"-*
      report="$OUT/$suite-$impl-$tztag.json"
      validations=$([ "$impl" = ts ] && echo ts || echo rs)
      TZ=$tz SQLITE_URL=file:$DB PAYLOAD_VALIDATIONS=$validations \
        pnpm vitest run --config test/__rs/core-validate/vitest.config.ts "test/$suite/int.spec.ts" \
        --reporter=json --outputFile="$report" > "$OUT/$suite-$impl-$tztag.log" 2>&1
      echo "$suite $impl $tz: $(node -e 'const r=require(process.argv[1]);console.log(`passed ${r.numPassedTests} failed ${r.numFailedTests} pending ${r.numPendingTests+r.numTodoTests} total ${r.numTotalTests}`)' "$report" 2>/dev/null || echo 'no report')"
    done
  done
done
rm -f "$DB" "$DB"-*
