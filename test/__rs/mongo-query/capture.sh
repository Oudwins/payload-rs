#!/usr/bin/env bash
# Captures the TS query builder calls of upstream int spec files on MongoDB (TS engine) into
# fixtures (test/__rs/mongo-query/capture.ts), then replays them in Rust.
#
#   test/__rs/mongo-query/capture.sh test/fields/int.spec.ts test/joins/int.spec.ts ...
#
# One vitest process and database per file (dropped afterwards). Fixtures go to
# test/__rs/mongo-query/fixtures/up-<name>-<pid>-<n>.json.gz.
set -uo pipefail
cd "$(dirname "$0")/../../.."
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$PWD/target/shared}
out=$PWD/test/__rs/mongo-query/fixtures
for file in "$@"; do
  name=$(echo "$file" | sed -E 's#^test/##; s#/int\.spec\.ts$##; s#\.int\.spec\.ts$##; s#[^a-zA-Z0-9]+#_#g')
  db="rsmqc_${name}_$$"
  RS_MQ_CAPTURE_DEBUG=1 RS_MQ_CAPTURE_DIR=$out RS_MQ_CAPTURE_TAG="up-$name" PAYLOAD_DATABASE=mongodb \
    MONGODB_URL="mongodb://payload:payload@localhost:27018/$db?authSource=admin&directConnection=true&replicaSet=rs0" \
    pnpm test:int --config test/__rs/mongo-query/vitest.capture.config.ts "$file" > "/tmp/rsmqc-$name.log" 2>&1
  echo "$file: $(grep -E '^ +Tests ' "/tmp/rsmqc-$name.log" | tail -1) ($(grep -c 'recording payload instance' "/tmp/rsmqc-$name.log") payload instances recorded)"
  node packages/engine-rs/scripts/mongo/mongoDatabases.mjs drop "$db" > /dev/null 2>&1
done
ls -la $out/up-*.error.txt 2>/dev/null
RS_MONGO_QUERY_FIXTURES=$out cargo test -q -p payload-mongo-query --test differential 2>&1 | grep -E "up-|total|kind|cases|failed|panicked" | tail -40
