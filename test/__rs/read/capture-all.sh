#!/usr/bin/env bash
# Regenerates every golden fixture for crates/payload-sql-read (git-ignored, ~26 MB).
#   bash test/__rs/read/capture-all.sh            # generic + synthetic + schema-linked + all suites below
#   RS_READ_SUITES="joins fields" bash test/__rs/read/capture-all.sh --suites-only
# Steps: capture with the real TS transform (process TZ is recorded per fixture), prune large
# fixtures, then replay every call through the TS transform in each zone of RS_READ_TZS to write
# the per-zone expectations (fixtures/tz/*.json), and regenerate dates.json.
# Then: cargo test -p payload-sql-read -- --nocapture
set -u
cd "$(dirname "$0")/../../.."

export SQLITE_URL="${SQLITE_URL:-file:/tmp/rs-read.db}"
export PAYLOAD_ENGINE=ts
zones="${RS_READ_TZS:-UTC,Europe/Lisbon,America/New_York}"

suites="${RS_READ_SUITES:-fields localization relationships versions joins database select fields-relationship nested-fields array-update collections-rest hooks globals uploads sort trash group-by field-paths lexical auth folders hierarchy locked-documents plugin-nested-docs query-presets dataloader access-control}"

if [ "${1:-}" != "--suites-only" ]; then
  pnpm test:int:sqlite test/__rs/read/capture.int.spec.ts 2>&1 | grep "\[rs-read\]"
  pnpm test:int:sqlite test/__rs/read/synthetic.int.spec.ts 2>&1 | grep "\[rs-read\]"
  # Production block-index path: one graph per context, configs without JS dbName functions.
  RS_READ_SCHEMA_LINKED=1 RS_READ_CONFIGS=fields,localization RS_READ_MAX_CALLS=800 \
    pnpm test:int:sqlite test/__rs/read/capture.int.spec.ts 2>&1 | grep "\[rs-read\]"
fi

for suite in $suites; do
  for spec in test/"$suite"/*int.spec.ts; do
    [ -f "$spec" ] || continue
    RS_READ_SUITE="${spec#test/}" pnpm test:int:sqlite test/__rs/read/suite.int.spec.ts 2>&1 \
      | grep -E "\[rs-read\]|Tests  " | sed "s|^|$spec: |"
  done
done

node test/__rs/read/capture/prune.mjs
for tz in ${zones//,/ }; do
  TZ="$tz" pnpm tsx test/__rs/read/capture/replay.ts | grep -E "TOTAL|wrote|differ from|replay does"
done
RS_READ_TZS="$zones" node test/__rs/read/capture/dates.mjs
rm -f /tmp/rs-read.db /tmp/rs-read.db-*
