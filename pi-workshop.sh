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
#   ./pi-workshop.sh --no-model             start without a model server
#
# Two models are configured. Pick one with WORKSHOP_MODEL; the default is Bonsai
# because it is the smaller download:
#   WORKSHOP_MODEL=granite-3b ./pi-workshop.sh
# Whichever you pick, the llamafile you are running must be the matching one.
set -euo pipefail

cd "$(dirname "$0")"

# Which of the models in .pi/agent/models.json to use. Both are configured with
# the same 16384-token context window, so the server command is identical either
# way — only the .llamafile you run differs.
WORKSHOP_MODEL="${WORKSHOP_MODEL:-bonsai-8b}"

# --no-model: skip the health check and start anyway. /phish still works, since
# it never calls the model. Anything you type at the agent will fail, which is
# the expected trade.
require_model=1
args=()
for a in "$@"; do
  if [ "$a" = "--no-model" ]; then
    require_model=0
  else
    args+=("$a")
  fi
done

# --- Find pi ----------------------------------------------------------------
#
# Preference order: an explicit PI_BIN, then the static build extracted into
# this folder, then whatever is on PATH. The static build is what the README
# asks you to download: it is a self-contained binary and needs no Node.js.
if [ -n "${PI_BIN:-}" ]; then
  pi_bin="$PI_BIN"
elif [ -x "./pi/pi" ]; then
  pi_bin="./pi/pi"
elif command -v pi > /dev/null 2>&1; then
  pi_bin="pi"
else
  cat >&2 <<'EOF'
Could not find pi.

Download the static build for your platform from
  https://github.com/earendil-works/pi/releases/tag/v0.84.2
and extract it here, so that ./pi/pi exists:

  tar -xzf pi-linux-x64.tar.gz          # or pi-darwin-arm64.tar.gz, etc.

It needs no Node.js and no npm. If you have pi installed some other way, put it
on your PATH or set PI_BIN=/path/to/pi.
EOF
  exit 1
fi

# Use the repo's model config instead of ~/.pi/agent. Read at startup, so this
# applies for this run only.
export PI_CODING_AGENT_DIR="$PWD/.pi/agent"

# Corporate proxies otherwise swallow requests to your own machine.
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"

if [ "$require_model" -eq 1 ] &&
   ! curl -sf --noproxy 127.0.0.1 http://127.0.0.1:8080/health > /dev/null 2>&1; then
  cat >&2 <<'EOF'
The model server is not responding on http://127.0.0.1:8080

Start it first, in another terminal:
  ./bonsai.llamafile --server --gpu disable -c 16384 -np 1

It takes a minute or two to load the weights before it answers. Run ./doctor.sh
to check everything else while you wait.

You are not blocked on it, though. The deterministic half of this workshop needs
no model at all:
  ./pi-workshop.sh --no-model      then use /phish <file>
EOF
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
# -nbt disables pi's built-in Read/Write/Edit/Bash tools while keeping extension
# tools. Their definitions are a large part of the prompt, and on a slow local
# model that cost is paid on every turn; a small model also tends to reach for
# them instead of answering. Drop the flag if you want the full coding agent.
#
# --offline stops pi making network calls at startup (model catalogue refresh
# and similar). Everything here is local, and on conference wifi a blocking
# startup fetch is exactly the kind of thing that looks like a hang.
exec "$pi_bin" \
  --provider local --model "$WORKSHOP_MODEL" \
  --system-prompt "$(cat workshop-system-prompt.md)" \
  --offline \
  -nbt \
  "${ext_args[@]}" ${args[@]+"${args[@]}"}
