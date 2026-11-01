#!/usr/bin/env bash
# Mutation testing: proves the differential suites detect deliberately wrong ports.
# Build the addon with the mutants feature first:
#   cargo build -p payload-node --features payload-core-hooks-validate/mutants
#   cp target/shared/debug/libpayload_node.dylib /tmp/bv-mutants.node
#   PAYLOAD_ENGINE_ADDON=/tmp/bv-mutants.node test/__rs/core-hooks-before-validate/mutants.sh "M1 M2" "synthetic hooks"
# Prints one `mutant suite runs=.. diffs=..` line per pair (diffs > 0 = mutant killed).
cd "$(dirname "$0")/../../.."
mutants="${1:-M1 M2 M3 M4 M5 M6 M7 M8 M9 M10 M11 M12 M13}"
suites="${2:-synthetic hooks fields localization core-runtime}"
db="/tmp/rs-before-validate.db"
for mutant in $mutants; do
  for suite in $suites; do
    rm -f "$db"*
    line=$(PAYLOAD_BV_MUTANT="$mutant" SQLITE_URL="file:${db}" TZ="${TZ:-UTC}" \
      pnpm test:int:sqlite "test/__rs/core-hooks-before-validate/${suite}.int.spec.ts" 2>&1 |
      grep -E 'core-hooks-before-validate\] ' | sed 's/.*: runs=/runs=/')
    echo "$mutant $suite ${line:-no-result}"
  done
done
rm -f "$db"*
