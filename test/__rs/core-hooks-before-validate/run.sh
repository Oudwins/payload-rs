#!/usr/bin/env bash
# Runs the beforeValidate differential suites one by one, sequentially on one SQLite file (recreated per suite).
#
#   PAYLOAD_ENGINE_ADDON=/path/to/payload-node.node test/__rs/core-hooks-before-validate/run.sh [hooks fields localization core-runtime synthetic]
set -euo pipefail
cd "$(dirname "$0")/../../.."
suites=("${@:-hooks fields localization core-runtime synthetic}")
for suite in ${suites[@]}; do
  db="${RS_CORE_HOOKS_BV_DB:-/tmp/rs-before-validate.db}"
  rm -f "$db"*
  SQLITE_URL="file:${db}" TZ="${TZ:-UTC}" pnpm test:int:sqlite "test/__rs/core-hooks-before-validate/${suite}.int.spec.ts"
  rm -f "$db"*
done
