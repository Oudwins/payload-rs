#!/usr/bin/env bash
# Mutation runs of the live write differential: each deliberately wrong behaviour of
# crates/payload-mongo-live-write (`mutant(n)`, debug addon, see its lib.rs) must make scenarios
# fail. Prints the number of failing tests per mutant; exits 1 if a mutant is not detected.
#
#   PAYLOAD_ENGINE_ADDON=.rs-runs/<label>/payload-engine.node test/__rs/mongo-live-writes/mutants.sh [1 2 ...]
set -uo pipefail
cd "$(dirname "$0")/../../.."
mutants=("${@:-1 2 3 4 5 6 7 8 9 10 11 12}")
undetected=0
for m in ${mutants[@]}; do
  mkdir -p .rs-runs/mongowrites/mutants; log=".rs-runs/mongowrites/mutants/lw-mutant-$m.log"
  PAYLOAD_RS_LIVE_WRITE_MUTANT=$m test/__rs/mongo-live-writes/run.sh "mongowrites_m$m" >"$log" 2>&1
  failed=$(grep -E "^ +× " "$log" | grep -vc "negative control")
  echo "mutant $m: $failed failing scenarios: $(grep -E '^ +× ' "$log" | head -3 | sed 's/^ *× //' | tr '\n' '|')"
  if [ "$failed" -eq 0 ]; then
    undetected=1
  fi
  :
done
exit $undetected
