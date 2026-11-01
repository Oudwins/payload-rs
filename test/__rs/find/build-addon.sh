#!/usr/bin/env bash
# Builds the find test addon (crates/payload-sql-find/napi-test, which also contains the
# payload-sqlite napi bindings) and copies it to a `.node` file for PAYLOAD_ENGINE_ADDON.
#   test/__rs/find/build-addon.sh [out-dir]   (default /tmp/rs-find-addon)
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
out="${1:-/tmp/rs-find-addon}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$root/target/shared}"
(cd "$root/crates/payload-sql-find/napi-test" && cargo build)
mkdir -p "$out"
cp "$CARGO_TARGET_DIR/debug/libpayload_sql_find_napi_test.dylib" "$out/payload-find-test.node"
echo "export PAYLOAD_ENGINE_ADDON=$out/payload-find-test.node"
