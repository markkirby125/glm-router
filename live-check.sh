#!/usr/bin/env bash
# Live check for the claude-glm setup.
# 1. Plain `claude` answers and does NOT touch the router (direct to Anthropic).
# 2. `claude-glm` answers for Claude and GLM models through the router.
# A model passes only if its whole reply is exactly "OK" (whitespace trimmed).
set -u
fail=0
router_hits() { journalctl --user -u glm-router.service --no-pager -o cat 2>/dev/null | grep -c ' -> '; }

ask() {  # ask <label> <model> <command...>
  local label=$1 model=$2 out reply
  shift 2
  out=$(timeout 150 "$@" -p --model "$model" --max-budget-usd 3 "Reply with the single word OK." </dev/null 2>&1)
  reply=$(printf '%s' "$out" | tr -d '[:space:]')
  if [ "$reply" = "OK" ]; then echo "PASS $label $model"; else echo "FAIL $label $model: ${out:0:200}"; fail=1; fi
}

before=$(router_hits)
# Run plain claude as a fresh terminal would: without any inherited router URL.
ask claude haiku env -u ANTHROPIC_BASE_URL -u ENABLE_TOOL_SEARCH claude
after=$(router_hits)
if [ "$after" -eq "$before" ]; then echo "PASS claude bypasses router"; else echo "FAIL claude sent $((after - before)) request(s) through the router"; fail=1; fi

for m in haiku sonnet opus glm-5.3 glm-5.3-flash; do ask claude-glm "$m" claude-glm; done
exit $fail
