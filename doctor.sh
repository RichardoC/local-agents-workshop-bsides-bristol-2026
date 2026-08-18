#!/usr/bin/env bash
#
# Check that this machine is ready for the workshop, and say exactly what to do
# about anything that is not.
#
# Every check here corresponds to something that has actually gone wrong, and
# most of them fail *silently* in normal use — a context window that does not
# match, a proxy that swallows requests to your own machine, four server slots
# instead of one. Those are the ones worth automating: an error message you can
# read is not the problem.
#
# Run it any time:  ./doctor.sh
#
# Exit code is 0 if you are ready to work, 1 if something is genuinely broken.
# Warnings do not fail: plenty of them are fine depending on your path through
# the session.

cd "$(dirname "$0")"

pass=0
warn=0
fail=0

# Colour only when attached to a terminal, so this stays readable when piped or
# pasted into a chat window for help.
if [ -t 1 ]; then
  G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; B=$'\033[1m'; D=$'\033[2m'; N=$'\033[0m'
else
  G=""; Y=""; R=""; B=""; D=""; N=""
fi

ok()   { printf '%s  ok  %s %s\n' "$G" "$N" "$1"; pass=$((pass + 1)); }
warns(){ printf '%s warn %s %s\n' "$Y" "$N" "$1"; warn=$((warn + 1)); [ -n "${2:-}" ] && printf '%s        %s%s\n' "$D" "$2" "$N"; }
bad()  { printf '%s FAIL %s %s\n' "$R" "$N" "$1"; fail=$((fail + 1)); [ -n "${2:-}" ] && printf '%s        %s%s\n' "$D" "$2" "$N"; }
head_() { printf '\n%s%s%s\n' "$B" "$1" "$N"; }

printf '%sWorkshop setup check%s  —  BSides Bristol 2026\n' "$B" "$N"

# --- Platform ---------------------------------------------------------------

head_ "Platform"

uname_s=$(uname -s 2>/dev/null || echo unknown)
uname_m=$(uname -m 2>/dev/null || echo unknown)

case "$uname_s" in
  Darwin) plat="darwin" ;;
  Linux)  plat="linux" ;;
  MINGW*|MSYS*|CYGWIN*) plat="windows" ;;
  *)      plat="unknown" ;;
esac
case "$uname_m" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *)             arch="unknown" ;;
esac

if [ "$plat" = unknown ] || [ "$arch" = unknown ]; then
  warns "Unrecognised platform: $uname_s / $uname_m" \
        "You will have to pick the right pi release asset by hand."
  asset="pi-<your-platform>.tar.gz"
else
  ok "$uname_s $uname_m  (pi asset: pi-$plat-$arch)"
  if [ "$plat" = "windows" ]; then asset="pi-$plat-$arch.zip"; else asset="pi-$plat-$arch.tar.gz"; fi
fi

# --- pi ---------------------------------------------------------------------

head_ "pi"

pi_bin=""
if [ -n "${PI_BIN:-}" ] && [ -x "$PI_BIN" ]; then
  pi_bin="$PI_BIN"; pi_src="PI_BIN"
elif [ -x "./pi/pi" ]; then
  pi_bin="./pi/pi"; pi_src="static build in ./pi/"
elif [ -x "./pi/pi.exe" ]; then
  pi_bin="./pi/pi.exe"; pi_src="static build in ./pi/"
elif command -v pi > /dev/null 2>&1; then
  pi_bin="pi"; pi_src="PATH"
fi

if [ -z "$pi_bin" ]; then
  bad "pi not found" \
      "Download $asset from https://github.com/earendil-works/pi/releases/tag/v0.84.2 and extract it here, so ./pi/pi exists."
else
  pi_ver=$("$pi_bin" --version 2>/dev/null | head -1)
  ok "pi ${pi_ver:-(version unknown)}  ${D}from $pi_src${N}"
fi

# --- Model server -----------------------------------------------------------

head_ "Model server"

model_file=$(ls -1 ./*.llamafile ./*.llamafile.exe 2>/dev/null | head -1)
n_models=$(ls -1 ./*.llamafile ./*.llamafile.exe 2>/dev/null | wc -l | tr -d ' ')
if [ "${n_models:-0}" -gt 1 ]; then
  warns "More than one .llamafile here: $(ls -1 ./*.llamafile ./*.llamafile.exe 2>/dev/null | tr '\n' ' ')" \
        "Harmless, but only start one — and make WORKSHOP_MODEL match the one you start."
fi
if [ -n "$model_file" ]; then
  sz=$(wc -c < "$model_file" 2>/dev/null || echo 0)
  if [ "$sz" -lt 100000000 ]; then
    bad "$model_file is only $((sz / 1048576)) MB — the download did not finish" \
        "Delete it and download again: about 1.5 GB for Bonsai, 3.1 GB for Granite."
  elif [ -x "$model_file" ]; then
    ok "$model_file  ($((sz / 1048576)) MB, executable)"
  else
    bad "$model_file is not executable" "Run: chmod +x $model_file"
  fi
else
  warns "No .llamafile found in this folder" \
        "Needed only for the agent half. See the README pre-flight section."
fi

props=$(curl -sf --noproxy 127.0.0.1 --max-time 5 http://127.0.0.1:8080/props 2>/dev/null)
if [ -z "$props" ]; then
  warns "Model server not responding on http://127.0.0.1:8080" \
        "Start it: ./bonsai.llamafile --server --gpu disable -c 16384 -np 1  (it takes a minute or two to load)"
else
  ok "Model server is up"

  # llamafile serves whatever weights it loaded and ignores the model name in
  # the request, so a mismatch between the llamafile you started and the model
  # you tell pi to use is silent. Report what is actually loaded.
  loaded=$(printf '%s' "$props" | tr ',{}' '\n\n\n' | grep -o '"model_path"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/' | head -1)
  if [ -n "$loaded" ]; then
    base=$(basename "$loaded")
    case "$base" in
      *[Bb]onsai*) want="bonsai-8b" ;;
      *granite*)   want="granite-3b" ;;
      *)           want="" ;;
    esac
    if [ -n "$want" ]; then
      ok "Server has $base loaded — use ${B}--model $want${N} (WORKSHOP_MODEL=$want)"
    else
      warns "Server has $base loaded, which is neither configured model" \
            "Add an entry for it to .pi/agent/models.json, or start the llamafile you meant to."
    fi
  fi

  # The two silent killers, both invisible until something behaves oddly.
  n_ctx=$(printf '%s' "$props" | tr ',{}' '\n\n\n' | grep -o '"n_ctx"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*$' | head -1)
  slots=$(printf '%s' "$props" | tr ',{}' '\n\n\n' | grep -o '"total_slots"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*$' | head -1)

  cfg_ctx=$(grep -o '"contextWindow"[[:space:]]*:[[:space:]]*[0-9]*' .pi/agent/models.json 2>/dev/null | grep -o '[0-9]*$' | head -1)

  if [ -n "$n_ctx" ] && [ -n "$cfg_ctx" ]; then
    if [ "$n_ctx" = "$cfg_ctx" ]; then
      ok "Context window agrees: server $n_ctx = models.json $cfg_ctx"
    else
      bad "Context window mismatch: server -c is $n_ctx, models.json says $cfg_ctx" \
          "These must match or replies get truncated — or vanish entirely with no error. Restart the server with -c $cfg_ctx."
    fi
  fi

  if [ -n "$slots" ]; then
    if [ "$slots" = "1" ]; then
      ok "Server has 1 slot (-np 1), so the KV cache is reused between turns"
    else
      bad "Server has $slots slots" \
          "Requests bounce between slots and the whole conversation is reprocessed every turn. Restart with -np 1."
    fi
  fi
fi

# --- Proxy ------------------------------------------------------------------

head_ "Network"

proxy_set=""
for v in HTTP_PROXY http_proxy HTTPS_PROXY https_proxy ALL_PROXY all_proxy; do
  eval "val=\${$v:-}"
  [ -n "$val" ] && proxy_set="$proxy_set $v"
done

if [ -z "$proxy_set" ]; then
  ok "No proxy configured — nothing to intercept local requests"
elif printf '%s' "${NO_PROXY:-}${no_proxy:-}" | grep -q '127\.0\.0\.1'; then
  ok "Proxy set ($(echo $proxy_set)) but NO_PROXY covers 127.0.0.1"
else
  warns "Proxy set ($(echo $proxy_set)) and NO_PROXY does not list 127.0.0.1" \
        "The launcher sets this for you. If you run pi directly: export NO_PROXY=127.0.0.1,localhost"
fi

# --- Samples ----------------------------------------------------------------

head_ "Sample emails"

n_syn=$(ls -1 samples/synthetic/*.eml 2>/dev/null | wc -l | tr -d ' ')
if [ "${n_syn:-0}" -ge 1 ]; then
  ok "$n_syn synthetic samples (MIT, always present, one signal each)"
else
  warns "No synthetic samples" "Regenerate them: node tools/make-samples.mjs"
fi

n_pot=$(ls -1 samples/phishing_pot/email/*.eml 2>/dev/null | wc -l | tr -d ' ')
if [ "${n_pot:-0}" -gt 0 ]; then
  ok "$n_pot real samples from the Phishing Pot submodule"
else
  warns "Phishing Pot submodule not populated (optional — the synthetic samples cover the exercises)" \
        "If you want the real corpus (422 MB): git submodule update --init --depth 1"
fi

# --- Node (optional) --------------------------------------------------------

head_ "Node.js ${D}(optional — only for npm test and the triage CLI)${N}"

if command -v node > /dev/null 2>&1; then
  node_ver=$(node --version 2>/dev/null)
  major=$(printf '%s' "$node_ver" | sed 's/^v//' | cut -d. -f1)
  minor=$(printf '%s' "$node_ver" | sed 's/^v//' | cut -d. -f2)
  if [ "${major:-0}" -gt 22 ] || { [ "${major:-0}" -eq 22 ] && [ "${minor:-0}" -ge 6 ]; }; then
    ok "node $node_ver"
  else
    warns "node $node_ver is too old for TypeScript stripping (need 22.6+)" \
          "pi itself does not care — it is a static binary. This only affects npm test."
  fi
else
  warns "node not installed" \
        "Not required. pi runs the extension without it; you just cannot run npm test or the triage CLI."
fi

# --- Publishing -------------------------------------------------------------
#
# The session's stated goal is that you leave with something published. Every
# check here fails at 15:00 if it is not sorted out beforehand, and 15:00 is far
# too late — all of it is silent until the moment you need it.

head_ "Publishing ${D}(the goal of the session)${N}"

if ! command -v git > /dev/null 2>&1; then
  bad "git not installed" "Install git, or plan to pair with a neighbour when we publish."
else
  ok "git $(git --version 2>/dev/null | awk '{print $3}')"
  if [ -z "$(git config --get user.name 2>/dev/null)" ] || [ -z "$(git config --get user.email 2>/dev/null)" ]; then
    bad "git has no author identity — 'git commit' will refuse to run" \
        "git config --global user.name \"Your Name\" && git config --global user.email \"you@example.com\""
  else
    ok "git identity: $(git config --get user.name) <$(git config --get user.email)>"
  fi
fi

if command -v gh > /dev/null 2>&1; then
  if gh auth status > /dev/null 2>&1; then
    ok "gh is authenticated — 'gh repo create --public --source=. --push' will work"
  else
    warns "gh is installed but not authenticated" "Run it now, not at 15:00:  gh auth login"
  fi
else
  warns "gh (GitHub CLI) not installed — optional, but it removes the hardest step" \
        "Without it you need a personal access token: GitHub has not accepted a password over HTTPS since 2021."
fi

if curl -sf --max-time 8 -o /dev/null https://github.com 2>/dev/null; then
  ok "github.com is reachable"
else
  warns "cannot reach github.com" \
        "Conference wifi may be filtering it, or a captive portal is intercepting TLS. Use a phone hotspot. Do NOT disable certificate verification."
fi

# --- Summary ----------------------------------------------------------------

printf '\n%s%d ok, %d warning(s), %d failure(s)%s\n' "$B" "$pass" "$warn" "$fail" "$N"

if [ "$fail" -gt 0 ]; then
  printf '%sFix the failures above before the exercises.%s\n' "$R" "$N"
  exit 1
fi

if [ -n "$props" ]; then
  printf 'Ready. Try:  %s./pi-workshop.sh%s\n' "$B" "$N"
else
  printf 'Ready for the no-model exercises. Try:  %s./pi-workshop.sh --no-model%s  then  %s/phish samples/synthetic/09-href-text-mismatch.eml%s\n' "$B" "$N" "$B" "$N"
fi
exit 0
