# Launch pi against the local llamafile, using the model config committed in
# this repo rather than anything in your home directory.
#
# Nothing outside this folder is touched or modified.
#
# Usage:
#   .\pi-workshop.ps1                        interactive
#   .\pi-workshop.ps1 -p "your question"     one-shot
#   .\pi-workshop.ps1 --no-model             start without a model server
#
# Two models are configured. Pick one with WORKSHOP_MODEL; the default is Bonsai
# because it is the smaller download:
#   $env:WORKSHOP_MODEL = "granite-3b"; .\pi-workshop.ps1
# Whichever you pick, the llamafile you are running must be the matching one.
#
# If PowerShell refuses to run this, it is the execution policy, not the script:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

# Which of the models in .pi\agent\models.json to use. Both are configured with
# the same 16384-token context window, so the server command is identical either
# way — only the .llamafile you run differs.
$workshopModel = if ($env:WORKSHOP_MODEL) { $env:WORKSHOP_MODEL } else { "bonsai-8b" }

# --no-model: skip the health check and start anyway. /phish still works, since
# it never calls the model. Anything you type at the agent will fail, which is
# the expected trade.
$requireModel = $true
$passthrough = @()
foreach ($a in $args) {
    if ($a -eq "--no-model") { $requireModel = $false } else { $passthrough += $a }
}

# --- Find pi ----------------------------------------------------------------
#
# Preference order: an explicit PI_BIN, then the static build extracted into
# this folder, then whatever is on PATH. The static build is a self-contained
# executable: no Node.js, no npm, nothing to install.
$piBin = $null
if ($env:PI_BIN -and (Test-Path $env:PI_BIN)) {
    $piBin = $env:PI_BIN
}
elseif (Test-Path ".\pi\pi.exe") {
    $piBin = ".\pi\pi.exe"
}
elseif (Get-Command pi -ErrorAction SilentlyContinue) {
    $piBin = "pi"
}
else {
    Write-Host -ForegroundColor Red @"
Could not find pi.

Download pi-windows-x64.zip (or pi-windows-arm64.zip on an ARM machine) from
  https://github.com/earendil-works/pi/releases/tag/v0.84.2
and extract it here, so that .\pi\pi.exe exists.

It needs no Node.js and no npm. If you have pi installed some other way, put it
on your PATH or set PI_BIN to its full path.
"@
    exit 1
}

# Use the repo's model config instead of ~\.pi\agent.
$env:PI_CODING_AGENT_DIR = Join-Path $PWD ".pi\agent"

# Corporate proxies otherwise swallow requests to your own machine.
$env:NO_PROXY = if ($env:NO_PROXY) { "127.0.0.1,localhost,$($env:NO_PROXY)" } else { "127.0.0.1,localhost" }
$env:no_proxy = $env:NO_PROXY

if ($requireModel) {
    try {
        # PowerShell 7+ has -NoProxy, which genuinely bypasses a configured proxy
        # for this request. 5.1 has no equivalent: passing -Proxy $null there is
        # treated as "not supplied" and the WinINET proxy still applies. Most
        # Windows proxy configs bypass loopback anyway, so 5.1 usually works; if
        # it does not, that is what the NO_PROXY advice in the README is for.
        $noProxy = if ($PSVersionTable.PSVersion.Major -ge 7) { @{ NoProxy = $true } } else { @{} }
        Invoke-WebRequest -Uri "http://127.0.0.1:8080/health" `
            -UseBasicParsing -TimeoutSec 5 @noProxy | Out-Null
    }
    catch {
        Write-Host -ForegroundColor Red @"
The model server is not responding on http://127.0.0.1:8080

Start it first, in another terminal:
  .\bonsai.llamafile.exe --server --gpu disable -c 16384 -np 1

It takes a minute or two to load the weights before it answers. Run
.\doctor.ps1 to check everything else while you wait.

You are not blocked on it, though. The deterministic half of this workshop needs
no model at all:
  .\pi-workshop.ps1 --no-model      then use /phish <file>
"@
        exit 1
    }
}

# Load every extension in extensions/ explicitly, so pi does not need to prompt
# you to trust the project.
$extArgs = @()
Get-ChildItem -Path "extensions" -Filter "*.ts" -File -ErrorAction SilentlyContinue | ForEach-Object {
    $extArgs += "-e"
    $extArgs += "./extensions/$($_.Name)"
}

# pi's default system prompt is written for large cloud models: it is long, and
# on a small local model it both costs a lot of prompt-processing time and tends
# to send the agent looping. A short, task-focused prompt works far better here.
$systemPrompt = Get-Content -Path "workshop-system-prompt.md" -Raw

# -nbt disables pi's built-in Read/Write/Edit/Bash tools while keeping extension
# tools. Their definitions are a large part of the prompt, and on a slow local
# model that cost is paid on every turn; a small model also tends to reach for
# them instead of answering. Drop the flag if you want the full coding agent.
#
# --offline stops pi making network calls at startup. Everything here is local,
# and on conference wifi a blocking startup fetch looks exactly like a hang.
& $piBin --provider local --model $workshopModel --system-prompt $systemPrompt `
    --offline -nbt @extArgs @passthrough
