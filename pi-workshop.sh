#!/usr/bin/env bash
#
# Launch pi against the local llamafile, using the model config committed in
# this repo rather than anything in your home directory.
#
# Nothing outside this folder is touched or modified. Delete the folder and
# every trace of the workshop is gone.
#
# Usage:
#   ./pi-workshop.sh                        interactive
#   ./pi-workshop.sh -p "your question"     one-shot
set -euo pipefail

cd "$(dirname "$0")"

# Use the repo's model config instead of ~/.pi/agent. Read at startup, so this
# applies for this run only.
export PI_CODING_AGENT_DIR="$PWD/.pi/agent"

# Corporate proxies otherwise swallow requests to your own machine.
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"

if ! curl -sf --noproxy 127.0.0.1 http://127.0.0.1:8080/health > /dev/null 2>&1; then
  echo "The model server is not responding on http://127.0.0.1:8080" >&2
  echo "Start it first, in another terminal:" >&2
  echo "  ./bonsai.llamafile --server --gpu disable -c 16384" >&2
  exit 1
fi

# Load every extension in extensions/ explicitly. Using -e rather than putting
# them in .pi/extensions/ means pi does not need to prompt you to trust the
# project, which is one less thing to explain.
ext_args=()
for f in extensions/*.ts; do
  [ -e "$f" ] || continue
  ext_args+=(-e "./$f")
done

# pi's default system prompt is written for large cloud models: it is long, and
# on a small local model it both costs a lot of prompt-processing time and tends
# to send the agent looping. A short, task-focused prompt works far better here.
exec pi \
  --provider local --model bonsai-8b \
  --system-prompt "$(cat workshop-system-prompt.md)" \
  "${ext_args[@]}" "$@"
