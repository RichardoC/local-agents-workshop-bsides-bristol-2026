#!/usr/bin/env bash
# Measure what pi actually sends as max_completion_tokens at each context depth.
#
# The request body is written before the model evaluates anything, so we can read
# it and kill pi immediately. That turns a ~50-minute cold prompt evaluation into
# a few seconds per depth, and directly tests whether the reply allowance is
# collapsing as context grows.
set -uo pipefail

REPO=/workspace/local-agents-workshop-bsides-bristol-2026
CFG=$REPO/.pi/agent/models.json
OUT=/workspace/clamp-measurements.txt
PROXY_LOG=/workspace/proxy.log

cd "$REPO"
export PI_CODING_AGENT_DIR="$REPO/.pi/agent"
export NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost"

cp "$CFG" /tmp/models.json.clampbak
# Point pi at the logging proxy so we can read the outbound request body.
sed -i 's|127.0.0.1:8080/v1|127.0.0.1:8081/v1|' "$CFG"

: > "$OUT"
{
  echo "contextWindow : $(grep -oE '"contextWindow": [0-9]+' "$CFG" | grep -oE '[0-9]+')"
  echo "maxTokens     : $(grep -oE '"maxTokens": [0-9]+' "$CFG" | grep -oE '[0-9]+')"
  echo "pi safety margin is a fixed 4096 tokens"
  echo
  printf "%-12s %-14s %-26s %s\n" "SESSION" "PROMPT_TOKENS" "MAX_COMPLETION_TOKENS_SENT" "VERDICT"
} >> "$OUT"

for sid in "$@"; do
  : > "$PROXY_LOG"

  timeout 180 pi \
    --provider local --model bonsai-8b \
    --fork "$sid" \
    -e ./extensions/phish-triage.ts \
    -p "Check samples/phishing_pot/email/sample-1050.eml and say whether it is worse than the others." \
    > /dev/null 2>&1 &
  pid=$!

  # Wait for the outbound request to appear, then stop pi - we only need the body.
  mct=""
  for _ in $(seq 1 120); do
    sleep 1
    mct=$(grep -oE '"max_completion_tokens":[0-9]+' "$PROXY_LOG" 2>/dev/null | head -1 | grep -oE '[0-9]+')
    [ -n "$mct" ] && break
  done
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null

  # Approximate prompt size from the captured request body.
  body_chars=$(grep -oE '^BODY: .*' "$PROXY_LOG" 2>/dev/null | head -1 | wc -c)
  est_tokens=$(( body_chars / 4 ))

  verdict="ok"
  if [ -z "$mct" ]; then
    verdict="NO REQUEST CAPTURED"
    mct="?"
  elif [ "$mct" -le 1 ]; then
    verdict="*** CLAMPED TO 1 - replies will be empty ***"
  elif [ "$mct" -lt 200 ]; then
    verdict="*** SEVERELY STARVED - replies will truncate ***"
  elif [ "$mct" -lt 1000 ]; then
    verdict="** tight - long replies will hit finish_reason=length **"
  fi

  printf "%-12s %-14s %-26s %s\n" "$sid" "~$est_tokens" "$mct" "$verdict" >> "$OUT"
done

cp /tmp/models.json.clampbak "$CFG"
echo >> "$OUT"
echo "CLAMP_DONE" >> "$OUT"
