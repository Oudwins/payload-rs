#!/usr/bin/env bash
# Mutation tests: builds deliberately wrong ports (cargo features of payload-core-hooks-change)
# and runs the differential suites against each; every mutant must produce diffs.
#
#   test/__rs/core-hooks-before-change/mutants.sh [suite...]   (default: hooks synthetic)
set -uo pipefail
cd "$(dirname "$0")/../../.."
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/target/shared}"
suites=("${@:-hooks synthetic}")
for mutant in mutant-skip-sync-await mutant-inline-traverse mutant-reverse-fields mutant-merge-before-errors; do
  cargo build -q -p payload-core-hooks-change --example before_change_addon --features "$mutant" < /dev/null || exit 1
  addon="/tmp/rs-before-change-${mutant}.node"
  cp "$CARGO_TARGET_DIR/debug/examples/libbefore_change_addon.dylib" "$addon"
  for suite in ${suites[@]}; do
    db="/tmp/rs-before-change.db"
    rm -f "$db" "$db-shm" "$db-wal" "$db-journal"
    line=$(PAYLOAD_CORE_RUNTIME_ADDON="$addon" SQLITE_URL="file:${db}" TZ="${TZ:-UTC}" \
      pnpm test:int:sqlite "test/__rs/core-hooks-before-change/${suite}.int.spec.ts" < /dev/null 2>&1 |
      grep -o 'diffs=[0-9]*' | tail -1)
    echo "${mutant} ${suite}: ${line:-no result}"
    rm -f "$db" "$db-shm" "$db-wal" "$db-journal"
  done
  rm -f "$addon"
done
# restore the normal build
cargo build -q -p payload-core-hooks-change --example before_change_addon < /dev/null
