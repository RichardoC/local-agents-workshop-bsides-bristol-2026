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
#
# If your machine is too slow to run a model locally and a hosted endpoint has
# been set up for the session, use that instead — see the "hosted" provider in
# .pi/agent/models.json:
#   export HF_TOKEN=hf_...
#   WORKSHOP_PROVIDER=hosted WORKSHOP_MODEL=granite-3b-hosted ./pi-workshop.sh
set -euo pipefail

cd "$(dirname "$0")"

# Which provider and model in .pi/agent/models.json to use. The two local models
# share a 16384-token context window, so the server command is identical either
# way — only the .llamafile you run differs.
WORKSHOP_PROVIDER="${WORKSHOP_PROVIDER:-local}"
# If the user set WORKSHOP_MODEL, that wins. If not, the launcher asks the server
# which weights it loaded and matches them (see below), and this is the fallback
# for when it cannot tell.
WORKSHOP_MODEL_EXPLICIT="${WORKSHOP_MODEL:-}"
WORKSHOP_MODEL="${WORKSHOP_MODEL:-granite-3b}"

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

# A hosted endpoint has no local server to check, and needs a token.
if [ "$WORKSHOP_PROVIDER" != "local" ]; then
  require_model=0
  if [ -z "${HF_TOKEN:-}" ]; then
    cat >&2 <<'EOF'
WORKSHOP_PROVIDER is not "local", so a hosted endpoint is expected — but HF_TOKEN
is not set, and pi will not offer a model it has no credentials for.

  export HF_TOKEN=hf_...

Also check that baseUrl in .pi/agent/models.json has been filled in: it ships as
a REPLACE-ME placeholder.
EOF
    exit 1
  fi
fi

# Health-check the URL pi will actually dial, not a hardcoded one. If someone
# edits baseUrl -- which the hosted contingency explicitly asks them to do -- a
# check against a fixed 127.0.0.1:8080 can pass while pi connects somewhere dead,
# and pi's failure for that is a bare "Connection error." with no URL in it.
health_url=$(sed -n '1,/"hosted"/p' .pi/agent/models.json 2>/dev/null \
  | grep -o '"baseUrl"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 \
  | sed 's/.*"\(https\{0,1\}:[^"]*\)".*/\1/; s|/v1/*$||' || true)
health_url="${health_url:-http://127.0.0.1:8080}"

# If WORKSHOP_MODEL was not set explicitly, ask the server which weights it has
# and pick the matching id. This removes an entire class of silent failure:
# llamafile serves whatever it loaded and ignores the model field in the request,
# so running the Granite llamafile while pi is told `bonsai-8b` produces
# confident answers from the wrong model, with no error anywhere. The two also
# want different sampling -- Granite is greedy, Bonsai is not -- so a mismatch
# silently applies the wrong one.
if [ -z "${WORKSHOP_MODEL_EXPLICIT:-}" ] && [ "$require_model" -eq 1 ] && [ "$WORKSHOP_PROVIDER" = "local" ]; then
  # `|| true` is load-bearing: under `set -e`, an assignment whose command
  # substitution fails takes the script down with it. When the server is not
  # running, curl fails and grep matches nothing, so without this the launcher
  # exits silently -- no message, no exit code anyone can read -- instead of
  # reaching the "server is not responding" advice twenty lines below.
  loaded=$(curl -sf --noproxy 127.0.0.1 --max-time 5 "$health_url/props" 2>/dev/null \
    | tr ',{}' '\n\n\n' | grep -o '"model_path"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | sed 's/.*"\([^"]*\)"$/\1/' | head -1 || true)
  case "$(printf '%s' "$loaded" | tr 'A-Z' 'a-z')" in
    *granite*) detected=granite-3b ;;
    *bonsai*)  detected=bonsai-8b ;;
    *)         detected="" ;;
  esac
  if [ -n "$detected" ] && [ "$detected" != "$WORKSHOP_MODEL" ]; then
    printf 'Using --model %s: the server has %s loaded.\n' \
      "$detected" "$(basename "$loaded")" >&2
    printf 'Set WORKSHOP_MODEL to override.\n' >&2
    WORKSHOP_MODEL="$detected"
  fi
fi

if [ "$require_model" -eq 1 ] &&
   ! curl -sf --noproxy 127.0.0.1 "$health_url/health" > /dev/null 2>&1; then
  cat >&2 <<EOF
The model server is not responding on $health_url

That URL comes from baseUrl in .pi/agent/models.json, which is where pi will
connect. If it is not what you expected, that file is what to fix.

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

# Skills the same way, and for the same reason. `package.json` does declare
# `pi.skills`, but package skill discovery requires the project to be trusted
# first, so on a fresh clone the skills are silently absent -- verified: without
# this loop the agent reports no skills at all. Passing --skill is documented and
# unconditional.
#
# WORKSHOP_SKILLS=0 skips them. A skill is text prepended to the system prompt,
# so on a very slow machine it is real prompt-processing time on every turn.
if [ "${WORKSHOP_SKILLS:-1}" != "0" ]; then
  for d in skills/*/; do
    [ -f "$d/SKILL.md" ] || continue
    ext_args+=(--skill "./${d%/}")
  done
fi

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
  --provider "$WORKSHOP_PROVIDER" --model "$WORKSHOP_MODEL" \
  --system-prompt "$(cat workshop-system-prompt.md)" \
  --offline \
  -nbt \
  "${ext_args[@]}" ${args[@]+"${args[@]}"}
