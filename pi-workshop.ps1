# Launch pi against the local llamafile, using the model config committed in
# this repo rather than anything in your home directory.
#
# Nothing outside this folder is touched or modified.
#
# Usage:
#   .\pi-workshop.ps1                        interactive
#   .\pi-workshop.ps1 -p "your question"     one-shot
#
# If PowerShell refuses to run this, it is the execution policy, not the script:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

# Use the repo's model config instead of ~\.pi\agent.
$env:PI_CODING_AGENT_DIR = Join-Path $PWD ".pi\agent"

# Corporate proxies otherwise swallow requests to your own machine.
$env:NO_PROXY = "127.0.0.1,localhost"
$env:no_proxy = $env:NO_PROXY

try {
    Invoke-WebRequest -Uri "http://127.0.0.1:8080/health" -UseBasicParsing -TimeoutSec 5 | Out-Null
}
catch {
    Write-Error @"
The model server is not responding on http://127.0.0.1:8080
Start it first, in another terminal:
  .\bonsai.llamafile --server --gpu disable -c 16384 -np 1
"@
    exit 1
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
& pi --provider local --model bonsai-8b --system-prompt $systemPrompt -nbt @extArgs @args
