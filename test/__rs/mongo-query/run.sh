#!/usr/bin/env bash
# Records the mongo query corpus of each suite through the real TS (MongoDB, TS engine), replays it
# in Rust (crates/payload-mongo-query example `replay`) and runs both sides' filters through
# mongoose. One database per suite, dropped afterwards.
#
#   test/__rs/mongo-query/run.sh fields relationships localization ...
#
# Then, without MongoDB: cargo test -p payload-mongo-query --test differential
set -uo pipefail
cd "$(dirname "$0")/../../.."
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$PWD/target/shared}
cargo build -q -p payload-mongo-query --example replay || exit 1
status=0
for suite in "$@"; do
  db="rsmq_$(echo "$suite" | tr -c 'a-zA-Z0-9\n' '_')_$$"
  RS_MQ_SUITE=$suite RS_MQ_REPLAY_BIN=$CARGO_TARGET_DIR/debug/examples/replay PAYLOAD_DATABASE=mongodb \
    MONGODB_URL="mongodb://payload:payload@localhost:27018/$db?authSource=admin&directConnection=true&replicaSet=rs0" \
    pnpm test:int --config test/__rs/mongo-harness/vitest.config.ts test/__rs/mongo-query/corpus.int.spec.ts \
    > "/tmp/rsmq-$suite.log" 2>&1 || status=1
  grep -E "\[rs mongo query\]|Tests |FAIL|Error" "/tmp/rsmq-$suite.log" | head -60
  node packages/engine-rs/scripts/mongo/mongoDatabases.mjs drop "$db" > /dev/null 2>&1
done
exit $status
