#!/bin/bash
# Keeps the composite mark fresh for Kuru (its withdrawal limiter rejects prices older than 1800 s) and settles the
# series after expiry. Monad bills the full gas limit, so a free dry simulation decides whether to broadcast.
# A simulation only proposes: its log is never proof. What counts is the chain after a broadcast (a new round whose
# evidence hash is this run's, recent enough to serve Kuru). A failed read or an unverifiable result is an ALERT
# line and a non-zero exit, never a silent success. The settlement quorum policy lives in the workflow, not here.
set -uo pipefail
export PATH="$PATH:$HOME/.bun/bin:$HOME/.foundry/bin:$HOME/.cre/bin:/opt/homebrew/bin:/usr/local/bin"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/evidence/keeper.log"
STATE="$ROOT/evidence/keeper.state"
EVIDENCE="$ROOT/evidence/composite"
HEARTBEAT=${PIRY_HEARTBEAT_SECONDS:-1200}
SETTLE_WINDOW=${PIRY_SETTLE_WINDOW_SECONDS:-86400}
MAX_ACCEPTED_AGE=${PIRY_MAX_ACCEPTED_AGE_SECONDS:-900}
POLL_SECONDS=${PIRY_POLL_SECONDS:-3}
MAX_SETTLE_FAILURES=${PIRY_MAX_SETTLE_FAILURES:-3}
SETTLE_FAILURES="$ROOT/evidence/settle.failures"
RPC=https://testnet-rpc.monad.xyz
STATUS=0
cd "$ROOT" && mkdir -p "$EVIDENCE" || exit 1

now() { echo "${PIRY_NOW:-$(date +%s)}"; }
log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }
alert() { log "ALERT $*"; STATUS=1; }
die() { alert "$*"; exit 1; }

command -v flock > /dev/null || die "flock is required so overlapping runs cannot double-broadcast"
exec 9> "$ROOT/evidence/keeper.lock"
flock -n 9 || { log "previous run still active; exiting"; exit 0; }

set -a; . ./.env.deployer; set +a
[ -n "${DEPLOYER_PRIVATE_KEY:-}" ] || die ".env.deployer is missing or has no DEPLOYER_PRIVATE_KEY"
export CRE_ETH_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY"
read -r MARKET FEED END < <(python3 -c "import json;d=json.load(open('deployments/monad-testnet.json'));c=d['contracts'];s=d['series'];print(c['market']['address'],c['markFeed']['address'],s['periodEnd'])") \
  || die "deployments/monad-testnet.json unreadable"

# One value per line (first word, so cast's [1.2e9] annotations drop out). Run it inside $(...) and exit on failure.
view() {
  local out
  out=$(cast call "$@" --rpc-url "$RPC" | awk '{print $1}') && [ -n "$out" ] || die "RPC read failed: $2 ${3:-}"
  echo "$out"
}
is_settled() {
  local answer
  answer=$(view "$MARKET" "settled()(bool)") || exit 1
  [[ $answer == true || $answer == false ]] || die "unexpected settled() answer: $answer"
  [ "$answer" = true ]
}
# latest_round sets LATEST; feed_round <id> sets ON_PRICE, ON_UPDATED and ON_HASH.
latest_round() {
  LATEST=$(view "$FEED" "latestRound()(uint80)") || exit 1
  [[ $LATEST =~ ^[0-9]+$ ]] || die "unexpected latestRound() answer: $LATEST"
}
feed_round() {
  local out
  out=$(view "$FEED" "rounds(uint80)(int256,uint256,uint64,bytes32)" "$1") || exit 1
  read -r _ ON_PRICE ON_UPDATED ON_HASH <<< "${out//$'\n'/ }"
  [[ $ON_PRICE =~ ^[0-9]+$ && $ON_UPDATED =~ ^[0-9]+$ && $ON_HASH =~ ^0x[0-9a-f]{64}$ ]] || die "unexpected rounds($1) answer: $out"
}
# The public RPC can trail the node that mined a broadcast by a block or two, so a landing check polls a few times.
retry() { local tries=$1 i; shift; for ((i = 1; i <= tries; i++)); do "$@" && return 0; [ "$i" -lt "$tries" ] && sleep "$POLL_SECONDS"; done; return 1; }
advanced() { latest_round; [ "$LATEST" -gt "$BEFORE" ]; }
sim() { (cd workflow && cre workflow simulate . -R . -T composite-settings --non-interactive --trigger-index "$1" "${@:2}" 2>&1); }
show() { grep -E "USER LOG|failed|rror" <<< "$1" | grep -vi private | cut -c1-260 >> "$LOG"; }

# Stores the evidence a run logged under its hash, byte for byte, only if keccak256 of those bytes is that hash.
save_evidence() {
  local json
  json=$(sed -n "s/.*PIRY_EVIDENCE $2 \({.*}\).*\$/\1/p" <<< "$1" | tail -1)
  [ -n "$json" ] && [ "$(printf '%s' "$json" | cast keccak)" = "$2" ] || return 1
  printf '%s' "$json" > "$EVIDENCE/$2.json.tmp" && mv "$EVIDENCE/$2.json.tmp" "$EVIDENCE/$2.json"
}

settle() {
  local out rc hash tries=1 failed
  # A receiver revert in simulation mode still bills the full gas limit, so stop broadcasting after a few misses.
  failed=$(cat "$SETTLE_FAILURES" 2>/dev/null || echo 0)
  if [ "$failed" -ge "$MAX_SETTLE_FAILURES" ]; then alert "settlement paused after $failed failed broadcasts; investigate, then delete $SETTLE_FAILURES"; return; fi
  out=$(sim 0 --broadcast); rc=$?
  log "settlement attempt (exit $rc)"; show "$out"
  [ "$rc" -eq 0 ] && tries=5
  if ! retry "$tries" is_settled; then
    # Quorum and timing refusals happen before any write; any other failure is an alert, and keeps the marks going.
    if grep -qE "settlement needs [0-9]+ valid sources|premature or outside|time margin puts" <<< "$out"; then log "settlement deferred"
    else echo $((failed + 1)) > "$SETTLE_FAILURES"; alert "settlement did not land (exit $rc)"; fi
    return
  fi
  hash=$(view "$MARKET" "settlementEvidenceHash()(bytes32)") || exit 1
  save_evidence "$out" "$hash" && log "settled; evidence $hash saved" || log "settled; evidence $hash was not logged by this run"
  exit "$STATUS"
}

mark() {
  local dry rc price out age
  dry=$(sim 1); rc=$?
  price=$(sed -n 's/.*COMPOSITE mark simulation: [^;]*; price=\([0-9]*\);.*/\1/p' <<< "$dry" | head -1)
  if [ "$rc" -ne 0 ] || [ -z "$price" ] || grep -qE "execution failed|delivery rejected" <<< "$dry"; then
    show "$dry"; die "dry run failed (exit $rc); its price is not trusted"
  fi
  latest_round; BEFORE=$LATEST
  feed_round "$BEFORE"
  age=$(( $(now) - ON_UPDATED ))
  if [ "$price" = "$ON_PRICE" ] && [ "$age" -lt "$HEARTBEAT" ]; then
    log "price $price unchanged, on-chain mark ${age}s old; skipped"; return
  fi
  out=$(sim 1 --broadcast); rc=$?
  log "mark dry price=$price, on-chain round $BEFORE price=$ON_PRICE ${age}s old (exit $rc)"; show "$out"
  retry 5 advanced || { alert "mark broadcast did not land (exit $rc)"; return; }
  feed_round "$LATEST"
  save_evidence "$out" "$ON_HASH" || { alert "round $LATEST is not this run's mark (evidence $ON_HASH not logged by it)"; return; }
  age=$(( $(now) - ON_UPDATED ))
  [ "$age" -le "$MAX_ACCEPTED_AGE" ] || { alert "round $LATEST accepted with updatedAt ${age}s old (limit $MAX_ACCEPTED_AGE)"; return; }
  printf '%s %s %s %s\n' "$ON_PRICE" "$ON_UPDATED" "$LATEST" "$ON_HASH" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
  log "mark landed: round $LATEST price=$ON_PRICE updatedAt=$ON_UPDATED (dry run said $price)"
}

if is_settled; then log "settled; nothing to do"; exit 0; fi
T=$(now)
if [ "$T" -ge $((END + 60)) ] && [ "$T" -le $((END + SETTLE_WINDOW)) ]; then settle; fi
mark
exit "$STATUS"
