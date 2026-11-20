#!/usr/bin/env bash
# Live write differential (crates/payload-mongo-live-write) on MongoDB:
#
#   PAYLOAD_ENGINE_ADDON=.rs-runs/<label>/payload-engine.node test/__rs/mongo-live-writes/run.sh [db-name]
#
# The TS reference must be upstream TS: PAYLOAD_ENGINE / PAYLOAD_CORE_ENGINE are unset. The database
# (default livewrites_1) is dropped afterwards. PAYLOAD_RS_MONGO_LIVE_UPSTREAM_DEPS=true makes the
# Rust methods call upstream's transform / buildQuery / ... instead of the registered live ports.
set -euo pipefail
cd "$(dirname "$0")/../../.."
unset PAYLOAD_ENGINE PAYLOAD_CORE_ENGINE
: "${PAYLOAD_ENGINE_ADDON:?set PAYLOAD_ENGINE_ADDON to the payload-node addon}"
db="${1:-livewrites_1}"
export PAYLOAD_DATABASE=mongodb
export MONGODB_URL="mongodb://payload:payload@localhost:27018/${db}?authSource=admin&directConnection=true&replicaSet=rs0"
status=0
pnpm test:int --config test/__rs/mongo-harness/vitest.config.ts test/__rs/mongo-live-writes/liveWrites.int.spec.ts || status=$?
node packages/engine-rs/scripts/mongo/mongoDatabases.mjs drop "$db" >/dev/null 2>&1 || true
exit $status
