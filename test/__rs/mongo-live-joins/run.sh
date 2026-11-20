#!/usr/bin/env bash
# In-situ dual-run of the joins ports over upstream spec files, one file at a time, each on its
# own database (dropped afterwards), in the given PAYLOAD_DATABASE modes (mongodb: join
# aggregations; firestore: useJoinAggregations false -> resolveJoins).
#
#   test/__rs/mongo-live-joins/run.sh <out-dir> <addon> <spec files...>
#   RS_LIVE_JOINS_DATABASES="mongodb firestore" RS_LIVE_JOINS_MODE=dual|self
set -u
out=$1; addon=$2; shift 2
root=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$out"
n=0
status=0
for db in ${RS_LIVE_JOINS_DATABASES:-mongodb firestore}; do
  for spec in "$@"; do
    n=$((n + 1))
    name="livejoins_r$$_$n"
    tag=$(echo "$spec" | tr '/.' '__')
    report="$out/$db-$tag.jsonl"
    rm -f "$report"
    (cd "$root" && PAYLOAD_DATABASE=$db PAYLOAD_ENGINE_ADDON=$addon RS_LIVE_JOINS_REPORT=$report \
      MONGODB_URL="mongodb://payload:payload@localhost:27018/$name?authSource=admin&directConnection=true&replicaSet=rs0" \
      pnpm vitest run --project int --config test/__rs/mongo-live-joins/vitest.config.ts "$spec" \
      > "$out/$db-$tag.log" 2>&1)
    echo "$db $spec: vitest exit $? $(grep -E '^ +Tests ' "$out/$db-$tag.log" | tr -s ' ')"
    node "$root/test/__rs/mongo-live-joins/check.mjs" "$report" || status=1
    node -e "
      const { createRequire } = require('module')
      const r = createRequire('$root/packages/db-mongodb/package.json')
      const { MongoClient } = r('mongodb')
      ;(async () => { const c = new MongoClient('mongodb://payload:payload@localhost:27018/?authSource=admin&directConnection=true&replicaSet=rs0'); await c.connect(); await c.db('$name').dropDatabase(); await c.close() })()
    "
  done
done
exit $status
