#!/usr/bin/env bash
# Live differentials of the Mongo query port (crates/payload-mongo-live-query) on MongoDB, one spec
# run per process, each with its own database (mongoquery_<pid>_<n>, dropped afterwards). The TS reference
# runs with PAYLOAD_ENGINE / PAYLOAD_CORE_ENGINE unset (the harness also fails if it reaches Rust).
#
#   PAYLOAD_ENGINE_ADDON=.rs-runs/mongoquery/payload-engine.node \
#     test/__rs/mongo-live-query/run.sh probes fields relationships localization joins ...
#
# `probes` runs probes.int.spec.ts (reviewers' probes, local config), `adversarial`
# adversarial.int.spec.ts (phase J review items + harness negative controls), `local` the corpus over the
# local config; any other name runs live.int.spec.ts on test/<name>/config.ts (RS_LQ_SUITE).
# RS_LQ_MUTANT=<name> runs a negative control (the run must report differences).
# Logs: $RS_LQ_LOG_DIR/livequery-<name>.log (default .rs-runs/mongoquery).
set -uo pipefail
cd "$(dirname "$0")/../../.."
unset PAYLOAD_ENGINE PAYLOAD_CORE_ENGINE
if [ -z "${PAYLOAD_CORE_RUNTIME_ADDON:-}${PAYLOAD_ENGINE_ADDON:-}" ]; then
  echo "set PAYLOAD_ENGINE_ADDON to an addon exporting mongoLiveQueryBinding" >&2
  exit 2
fi
log_dir=${RS_LQ_LOG_DIR:-.rs-runs/mongoquery}
mkdir -p "$log_dir"
status=0
n=0
for name in "$@"; do
  n=$((n + 1))
  db="mongoquery_$$_${n}"
  suite=$name
  if [ "$name" = probes ]; then
    spec=test/__rs/mongo-live-query/probes.int.spec.ts
  elif [ "$name" = adversarial ]; then
    spec=test/__rs/mongo-live-query/adversarial.int.spec.ts
  else
    spec=test/__rs/mongo-live-query/live.int.spec.ts
    # `local`: the corpus over this directory's config.ts (the probes' field shapes)
    [ "$name" = local ] && suite=./config.ts
  fi
  RS_LQ_SUITE=$suite PAYLOAD_DATABASE=mongodb \
    MONGODB_URL="mongodb://payload:payload@localhost:27018/$db?authSource=admin&directConnection=true&replicaSet=rs0" \
    pnpm test:int --config test/__rs/mongo-harness/vitest.config.ts "$spec" > "$log_dir/livequery-$name.log" 2>&1 || status=1
  grep -E "\[rs live query\]|Tests |FAIL|Error:|AssertionError" "$log_dir/livequery-$name.log" | head -40
  node packages/engine-rs/scripts/mongo/mongoDatabases.mjs drop "$db" > /dev/null 2>&1
done
exit $status
