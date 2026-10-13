#!/bin/bash
# Keeps the composite mark fresh for Kuru (its withdrawal limiter rejects prices older than 1800 s) and settles the
# series after expiry. Monad bills the full gas limit, so a free dry simulation decides whether to broadcast.
set -u
export PATH="$HOME/.bun/bin:$HOME/.foundry/bin:$HOME/.cre/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/evidence/keeper.log"
STATE="$ROOT/evidence/keeper.state"
HEARTBEAT=${PIRY_HEARTBEAT_SECONDS:-1200}
FULL_QUORUM_SECONDS=${PIRY_FULL_QUORUM_SECONDS:-14400}
SETTLE_WINDOW=${PIRY_SETTLE_WINDOW_SECONDS:-86400}
cd "$ROOT"
set -a; . ./.env.deployer; set +a
export CRE_ETH_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY"
RPC=https://testnet-rpc.monad.xyz
read -r MARKET FEED END < <(python3 -c "import json;d=json.load(open('deployments/monad-testnet.json'));c=d['contracts'];s=d['series'];print(c['market']['address'],c['markFeed']['address'],s['periodEnd'])")
NOW=$(date +%s)
stamp() { date -u +%FT%TZ; }
sim() { (cd workflow && cre workflow simulate . -R . -T composite-settings --non-interactive --trigger-index "$1" "${@:2}" 2>&1); }
SETTLED=$(cast call "$MARKET" "settled()(bool)" --rpc-url "$RPC" 2>/dev/null)
[ "$SETTLED" = "true" ] && { echo "$(stamp) settled; nothing to do" >> "$LOG"; exit 0; }
DRY=$(sim 1)
PRICE=$(printf '%s' "$DRY" | sed -n 's/.*COMPOSITE mark simulation: [^;]*; price=\([0-9]*\);.*/\1/p' | head -1)
SOURCES=$(printf '%s' "$DRY" | sed -n 's/.*COMPOSITE mark simulation: [^;]*; price=[0-9]*; slots=\([0-9]*\);.*/\1/p' | head -1)
[ -z "$PRICE" ] && { echo "$(stamp) ALERT dry run produced no price" >> "$LOG"; exit 0; }
# One missing source moves a two-cluster median a long way, so settle on a full quorum while there is time to wait.
if [ "$NOW" -ge $((END + 60)) ] && [ "$NOW" -le $((END + SETTLE_WINDOW)) ]; then
  if [ "${SOURCES:-0}" -ge 4 ] || { [ "$NOW" -ge $((END + FULL_QUORUM_SECONDS)) ] && [ "${SOURCES:-0}" -ge 3 ]; }; then
    { echo "$(stamp) settle (sources=$SOURCES, price=$PRICE)"; sim 0 --broadcast | grep -E "USER LOG|failed|rror" | grep -vi private | cut -c1-260; } >> "$LOG" 2>&1
    [ "$(cast call "$MARKET" "settled()(bool)" --rpc-url "$RPC" 2>/dev/null)" = "true" ] && exit 0
  else
    echo "$(stamp) settlement deferred: $SOURCES of 4 sources valid" >> "$LOG"
  fi
fi
LAST_PRICE=""; LAST_TS=0
[ -f "$STATE" ] && read -r LAST_PRICE LAST_TS < "$STATE"
if [ "$PRICE" = "$LAST_PRICE" ] && [ $((NOW - LAST_TS)) -lt "$HEARTBEAT" ]; then
  echo "$(stamp) price $PRICE unchanged, heartbeat not due; skipped" >> "$LOG"; exit 0
fi
BEFORE=$(cast call "$FEED" "latestRound()(uint80)" --rpc-url "$RPC" 2>/dev/null)
{ echo "$(stamp) mark price=$PRICE sources=$SOURCES"; sim 1 --broadcast | grep -E "USER LOG|failed|rror" | grep -vi private | cut -c1-260; } >> "$LOG" 2>&1
AFTER=$(cast call "$FEED" "latestRound()(uint80)" --rpc-url "$RPC" 2>/dev/null)
if [ -n "$AFTER" ] && [ "$AFTER" != "$BEFORE" ]; then echo "$PRICE $NOW" > "$STATE"; else echo "$(stamp) ALERT mark broadcast did not land" >> "$LOG"; fi
