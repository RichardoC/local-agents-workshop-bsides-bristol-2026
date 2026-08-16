# Check that this machine is ready for the workshop, and say exactly what to do
# about anything that is not.
#
# Every check here corresponds to something that has actually gone wrong, and
# most of them fail *silently* in normal use — a context window that does not
# match, a proxy that swallows requests to your own machine, four server slots
# instead of one. Those are the ones worth automating: an error message you can
# read is not the problem.
#
# Run it any time:  .\doctor.ps1
#
# If PowerShell refuses to run this, it is the execution policy, not the script:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

$ErrorActionPreference = "Continue"
Set-Location -Path $PSScriptRoot

$script:pass = 0
$script:warn = 0
$script:fail = 0

function Ok($msg)            { Write-Host "  ok   " -ForegroundColor Green -NoNewline; Write-Host $msg; $script:pass++ }
function Warn($msg, $fix)    { Write-Host " warn  " -ForegroundColor Yellow -NoNewline; Write-Host $msg; if ($fix) { Write-Host "        $fix" -ForegroundColor DarkGray }; $script:warn++ }
function Bad($msg, $fix)     { Write-Host " FAIL  " -ForegroundColor Red -NoNewline; Write-Host $msg; if ($fix) { Write-Host "        $fix" -ForegroundColor DarkGray }; $script:fail++ }
function Section($t)         { Write-Host ""; Write-Host $t -ForegroundColor White }

Write-Host "Workshop setup check" -ForegroundColor White -NoNewline
Write-Host "  —  BSides Bristol 2026"

# --- Platform ---------------------------------------------------------------

Section "Platform"

$arch = if ($env:PROCESSOR_ARCHITECTURE -match "ARM") { "arm64" } else { "x64" }
$asset = "pi-windows-$arch.zip"
Ok "Windows $arch  (pi asset: $asset)"

if ($PSVersionTable.PSVersion.Major -lt 5) {
    Warn "PowerShell $($PSVersionTable.PSVersion) is very old" "Windows 10 and later ship 5.1, which is fine."
} else {
    Ok "PowerShell $($PSVersionTable.PSVersion)"
}

# --- pi ---------------------------------------------------------------------

Section "pi"

$piBin = $null; $piSrc = $null
if ($env:PI_BIN -and (Test-Path $env:PI_BIN))        { $piBin = $env:PI_BIN; $piSrc = "PI_BIN" }
elseif (Test-Path ".\pi\pi.exe")                     { $piBin = ".\pi\pi.exe"; $piSrc = "static build in .\pi\" }
elseif (Get-Command pi -ErrorAction SilentlyContinue) { $piBin = "pi"; $piSrc = "PATH" }

if (-not $piBin) {
    Bad "pi not found" "Download $asset from https://github.com/earendil-works/pi/releases/tag/v0.84.2 and extract it here, so .\pi\pi.exe exists."
} else {
    $piVer = (& $piBin --version 2>$null | Select-Object -First 1)
    Ok "pi $piVer  (from $piSrc)"
}

# --- Model server -----------------------------------------------------------

Section "Model server"

$modelFile = Get-ChildItem -Path "." -Filter "*.llamafile*" -File -ErrorAction SilentlyContinue | Select-Object -First 1
if ($modelFile) {
    $mb = [int]($modelFile.Length / 1MB)
    if ($mb -lt 100) {
        Bad "$($modelFile.Name) is only $mb MB — the download did not finish" "Delete it and download again. It should be roughly 1.5 GB."
    } else {
        Ok "$($modelFile.Name)  ($mb MB)"
        if ($modelFile.Name -notlike "*.exe") {
            Warn "$($modelFile.Name) has no .exe extension" "Windows will not run it. Rename it to $($modelFile.Name).exe"
        }
    }
} else {
    Warn "No .llamafile found in this folder" "Needed only for the agent half. See the README pre-flight section."
}

$props = $null
try {
    $props = Invoke-RestMethod -Uri "http://127.0.0.1:8080/props" -TimeoutSec 5 -Proxy $null
} catch { }

if (-not $props) {
    Warn "Model server not responding on http://127.0.0.1:8080" "Start it: .\bonsai.llamafile.exe --server --gpu disable -c 16384 -np 1  (it takes a minute or two to load)"
} else {
    Ok "Model server is up"

    # The two silent killers, both invisible until something behaves oddly.
    $nCtx = $props.default_generation_settings.n_ctx
    $slots = $props.total_slots

    $cfgCtx = $null
    if (Test-Path ".pi\agent\models.json") {
        $cfgCtx = (Get-Content ".pi\agent\models.json" -Raw | ConvertFrom-Json).providers.local.models[0].contextWindow
    }

    if ($nCtx -and $cfgCtx) {
        if ($nCtx -eq $cfgCtx) {
            Ok "Context window agrees: server $nCtx = models.json $cfgCtx"
        } else {
            Bad "Context window mismatch: server -c is $nCtx, models.json says $cfgCtx" "These must match or replies get truncated — or vanish entirely with no error. Restart the server with -c $cfgCtx."
        }
    }

    if ($slots) {
        if ($slots -eq 1) {
            Ok "Server has 1 slot (-np 1), so the KV cache is reused between turns"
        } else {
            Bad "Server has $slots slots" "Requests bounce between slots and the whole conversation is reprocessed every turn. Restart with -np 1."
        }
    }
}

# --- Network ----------------------------------------------------------------

Section "Network"

$proxyVars = @("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY") | Where-Object { [Environment]::GetEnvironmentVariable($_) }
if (-not $proxyVars) {
    Ok "No proxy configured — nothing to intercept local requests"
} elseif ("$env:NO_PROXY" -match "127\.0\.0\.1") {
    Ok "Proxy set ($($proxyVars -join ', ')) but NO_PROXY covers 127.0.0.1"
} else {
    Warn "Proxy set ($($proxyVars -join ', ')) and NO_PROXY does not list 127.0.0.1" "The launcher sets this for you. If you run pi directly: `$env:NO_PROXY = '127.0.0.1,localhost'"
}

# --- Samples ----------------------------------------------------------------

Section "Sample emails"

$nSyn = (Get-ChildItem -Path "samples\synthetic" -Filter "*.eml" -ErrorAction SilentlyContinue).Count
if ($nSyn -ge 1) {
    Ok "$nSyn synthetic samples (MIT, always present, one signal each)"
} else {
    Warn "No synthetic samples" "Regenerate them: node tools\make-samples.mjs"
}

$nPot = (Get-ChildItem -Path "samples\phishing_pot\email" -Filter "*.eml" -ErrorAction SilentlyContinue).Count
if ($nPot -gt 0) {
    Ok "$nPot real samples from the Phishing Pot submodule"
} else {
    Warn "Phishing Pot submodule not populated (optional — the synthetic samples cover the exercises)" "If you want the real corpus (422 MB): git submodule update --init --depth 1"
}

# --- Node (optional) --------------------------------------------------------

Section "Node.js (optional — only for npm test and the triage CLI)"

if (Get-Command node -ErrorAction SilentlyContinue) {
    $nodeVer = (node --version)
    $parts = $nodeVer.TrimStart('v').Split('.')
    if ([int]$parts[0] -gt 22 -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -ge 6)) {
        Ok "node $nodeVer"
    } else {
        Warn "node $nodeVer is too old for TypeScript stripping (need 22.6+)" "pi itself does not care — it is a static binary. This only affects npm test."
    }
} else {
    Warn "node not installed" "Not required. pi runs the extension without it; you just cannot run npm test or the triage CLI."
}

# --- Summary ----------------------------------------------------------------

Write-Host ""
Write-Host "$script:pass ok, $script:warn warning(s), $script:fail failure(s)" -ForegroundColor White

if ($script:fail -gt 0) {
    Write-Host "Fix the failures above before the exercises." -ForegroundColor Red
    exit 1
}

if ($props) {
    Write-Host "Ready. Try:  .\pi-workshop.ps1"
} else {
    Write-Host "Ready for the no-model exercises. Try:  .\pi-workshop.ps1 --no-model  then  /phish samples\synthetic\09-href-text-mismatch.eml"
}
exit 0
