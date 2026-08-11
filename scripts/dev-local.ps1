#Requires -Version 7
<#
.SYNOPSIS
  Windows one-shot local loop: build -> safe install -> SiYuan reload -> MCP smoke -> fail recovery.

.DESCRIPTION
  Installs repo dist/ into <Workspace>/data/plugins/siyuanmaster only.
  Never recursive-deletes plugin/backup dirs. Never overwrites an existing target via Copy-Item.
  Token is read from <Workspace>/conf/conf.json (api.token) into process env only; never printed or written.

.PARAMETER Workspace
  Absolute or relative SiYuan workspace root (must contain data/, and conf/ when reloading).

.PARAMETER SkipBuild
  Skip pnpm build (use existing dist/).

.PARAMETER SkipReload
  Install only; do not call setPetalEnabled or MCP smoke. Prints "manual restart required".
  By default, if the ApiBaseUrl TCP port is reachable, install is refused (running instance would keep old files).
  Pass -AllowRunningWithoutReload only when you accept that risk.

.PARAMETER AllowRunningWithoutReload
  With -SkipReload only: allow install even when ApiBaseUrl port is reachable.
  Risk: a running SiYuan may continue serving the previous plugin bits until a real reload/restart.

.PARAMETER ReadSmoke
  After reload, run smoke:mcp with --read-smoke (metadata-only audit may be written).

.PARAMETER WhatIf
  Validate paths/artifacts and print plan only. No build, API, TCP, mkdir, move, or env mutation.

.PARAMETER ApiBaseUrl
  SiYuan HTTP origin only (default http://127.0.0.1:6806). Loopback only: localhost / 127.0.0.0/8 / ::1.
  Must be a strict origin: no userinfo, query, or fragment; path empty or "/".
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $Workspace,

    [switch] $SkipBuild,
    [switch] $SkipReload,
    [switch] $AllowRunningWithoutReload,
    [switch] $ReadSmoke,
    [switch] $WhatIf,

    [string] $ApiBaseUrl = "http://127.0.0.1:6806",

    # Hidden test hook only: throw after old target is successfully moved to backup.
    # Does not bypass validation. Not documented for operators.
    [Parameter(DontShow = $true)]
    [switch] $TestFailAfterBackupMove,

    # Hidden test hook: after new install, skip quarantine move so target stays occupied (recovery path).
    [Parameter(DontShow = $true)]
    [switch] $TestFailQuarantine,

    # Hidden test hook: throw immediately after successful staging->target swap (newInstalled=true).
    [Parameter(DontShow = $true)]
    [switch] $TestFailAfterSwap
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$PluginName = "siyuanmaster"
$RequiredFiles = @(
    "index.js",
    "index.css",
    "kernel.js",
    "plugin.json",
    "README.md",
    "README.zh-CN.md",
    "icon.png",
    "preview.png"
)
$RequiredDirs = @("i18n", "agent-skill")
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$DistDir = Join-Path $RepoRoot "dist"

# ---------------------------------------------------------------------------
# Helpers (no secrets in messages)
# ---------------------------------------------------------------------------

function Write-Stage {
    param([string] $Stage, [string] $Message)
    Write-Host "[dev-local] stage=$Stage $Message"
}

function Test-IsReparsePoint {
    param([string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }
    $item = Get-Item -LiteralPath $Path -Force
    return [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

function Assert-ExistingPathNotReparse {
    param(
        [string] $Path,
        [string] $Label
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "stage=validate $Label exists but is not a directory: $Path"
    }
    if (Test-IsReparsePoint -Path $Path) {
        throw "stage=validate refusing reparse point (junction/symlink) for ${Label}: $Path"
    }
}

function Assert-ExistingParentsNotReparse {
    param(
        [string] $Path,
        [string] $Label
    )
    $normalized = $Path.TrimEnd('\', '/')
    $parent = [System.IO.Path]::GetDirectoryName($normalized)
    while (-not [string]::IsNullOrWhiteSpace($parent)) {
        Assert-ExistingPathNotReparse -Path $parent -Label "${Label} parent"
        $next = [System.IO.Path]::GetDirectoryName($parent.TrimEnd('\', '/'))
        if ([string]::IsNullOrWhiteSpace($next) -or $next -eq $parent) {
            break
        }
        $parent = $next
    }
}

function Assert-NoReparsePointsRecursive {
    param(
        [string] $Root,
        [string] $Label
    )
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        throw "stage=validate $Label directory missing: $Root"
    }
    if (Test-IsReparsePoint -Path $Root) {
        throw "stage=validate refusing reparse point (junction/symlink) for ${Label}: $Root"
    }
    Get-ChildItem -LiteralPath $Root -Recurse -Force -ErrorAction Stop | ForEach-Object {
        if ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw "stage=validate refusing reparse point under ${Label}: $($_.FullName)"
        }
    }
}

function Resolve-StrictLoopbackOrigin {
    param([string] $Url)
    if ([string]::IsNullOrWhiteSpace($Url)) {
        throw "stage=validate ApiBaseUrl is required"
    }
    try {
        $uri = [Uri]$Url
    } catch {
        throw "stage=validate ApiBaseUrl is not a valid URL"
    }
    if (-not $uri.IsAbsoluteUri) {
        throw "stage=validate ApiBaseUrl must be an absolute URL origin"
    }
    if ($uri.Scheme -notin @("http", "https")) {
        throw "stage=validate ApiBaseUrl must be http(s); got scheme=$($uri.Scheme)"
    }
    if (-not [string]::IsNullOrEmpty($uri.UserInfo)) {
        throw "stage=validate ApiBaseUrl must be a pure origin (no userinfo/credentials)"
    }
    if (-not [string]::IsNullOrEmpty($uri.Query)) {
        throw "stage=validate ApiBaseUrl must be a pure origin (no query)"
    }
    if (-not [string]::IsNullOrEmpty($uri.Fragment)) {
        throw "stage=validate ApiBaseUrl must be a pure origin (no fragment)"
    }
    $path = $uri.AbsolutePath
    if (-not [string]::IsNullOrEmpty($path) -and $path -ne "/") {
        throw "stage=validate ApiBaseUrl must be a pure origin (path must be empty or '/')"
    }

    $hostName = $uri.IdnHost
    if ([string]::IsNullOrWhiteSpace($hostName)) {
        $hostName = $uri.Host
    }
    $hostName = $hostName.Trim().TrimStart("[").TrimEnd("]").ToLowerInvariant()
    $isLoopback = $false
    if ($hostName -eq "localhost" -or $hostName -eq "::1") {
        $isLoopback = $true
    } elseif ($hostName -match '^127(?:\.(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$') {
        $isLoopback = $true
    }
    if (-not $isLoopback) {
        throw "stage=validate ApiBaseUrl must be loopback only (localhost / 127.0.0.0/8 / ::1); got host=$hostName"
    }

    # Origin string without credentials (userinfo already rejected).
    $hostAndPort = $uri.GetComponents(
        [System.UriComponents]::HostAndPort,
        [System.UriFormat]::UriEscaped
    )
    $origin = "{0}://{1}" -f $uri.Scheme, $hostAndPort
    return [pscustomobject]@{
        Uri    = $uri
        Origin = $origin
        McpUrl = ($origin.TrimEnd("/") + "/mcp")
    }
}

function Assert-PluginDist {
    param([string] $Dir, [string] $Context = "dist")
    if (-not (Test-Path -LiteralPath $Dir -PathType Container)) {
        throw "stage=validate $Context directory missing: $Dir"
    }
    Assert-NoReparsePointsRecursive -Root $Dir -Label $Context
    foreach ($name in $RequiredFiles) {
        $p = Join-Path $Dir $name
        if (-not (Test-Path -LiteralPath $p -PathType Leaf)) {
            throw "stage=validate $Context missing required file: $name"
        }
    }
    foreach ($name in $RequiredDirs) {
        $p = Join-Path $Dir $name
        if (-not (Test-Path -LiteralPath $p -PathType Container)) {
            throw "stage=validate $Context missing required directory: $name"
        }
        if (Test-IsReparsePoint -Path $p) {
            throw "stage=validate $Context refusing reparse point for required dir ${name}: $p"
        }
    }
    $pluginJsonPath = Join-Path $Dir "plugin.json"
    try {
        $meta = Get-Content -LiteralPath $pluginJsonPath -Raw -Encoding utf8 | ConvertFrom-Json
    } catch {
        throw "stage=validate $Context plugin.json is not valid JSON"
    }
    if ($null -eq $meta.name -or [string]$meta.name -ne $PluginName) {
        throw "stage=validate $Context plugin.json name must be exactly '$PluginName'"
    }
}

function Assert-ExistingTargetIsSiYuanMasterPlugin {
    param([string] $TargetDir)
    $pluginJsonPath = Join-Path $TargetDir "plugin.json"
    if (-not (Test-Path -LiteralPath $pluginJsonPath -PathType Leaf)) {
        throw "stage=validate existing target missing plugin.json; refusing to treat ordinary directory as $PluginName backup: $TargetDir"
    }
    try {
        $meta = Get-Content -LiteralPath $pluginJsonPath -Raw -Encoding utf8 | ConvertFrom-Json
    } catch {
        throw "stage=validate existing target plugin.json is not valid JSON; refusing backup: $TargetDir"
    }
    if ($null -eq $meta.name -or [string]$meta.name -ne $PluginName) {
        throw "stage=validate existing target plugin.json name must be exactly '$PluginName'; refusing to treat ordinary directory as backup"
    }
}

function Copy-DistToStaging {
    param([string] $SourceDist, [string] $StagingPath)
    if (Test-Path -LiteralPath $StagingPath) {
        throw "stage=stage staging path already exists (refusing overwrite): $StagingPath"
    }
    $null = New-Item -ItemType Directory -Path $StagingPath -Force
    # Copy children into a brand-new directory only (never onto an existing plugin target).
    Get-ChildItem -LiteralPath $SourceDist -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $StagingPath $_.Name) -Recurse -Force
    }
    Assert-PluginDist -Dir $StagingPath -Context "staging"
}

function Read-WorkspaceApiToken {
    param([string] $WorkspaceRoot)
    $confPath = Join-Path $WorkspaceRoot "conf/conf.json"
    if (-not (Test-Path -LiteralPath $confPath -PathType Leaf)) {
        throw "stage=token workspace conf missing: conf/conf.json"
    }
    try {
        $conf = Get-Content -LiteralPath $confPath -Raw -Encoding utf8 | ConvertFrom-Json
    } catch {
        throw "stage=token conf/conf.json is not valid JSON"
    }
    $token = $null
    if ($null -ne $conf.api -and $null -ne $conf.api.token) {
        $token = [string]$conf.api.token
    }
    if ([string]::IsNullOrWhiteSpace($token)) {
        throw "stage=token conf/conf.json api.token is empty or missing"
    }
    return $token
}

function Test-TcpPortOpen {
    param(
        [System.Uri] $Uri,
        [int] $TimeoutMs = 400
    )
    $hostName = $Uri.IdnHost
    if ([string]::IsNullOrWhiteSpace($hostName)) {
        $hostName = $Uri.Host
    }
    $port = $Uri.Port
    if ($port -le 0) {
        if ($Uri.Scheme -eq "https") { $port = 443 } else { $port = 80 }
    }
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $iar = $client.BeginConnect($hostName, $port, $null, $null)
        $completed = $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)
        if (-not $completed) {
            return $false
        }
        try {
            $client.EndConnect($iar)
            return $true
        } catch {
            return $false
        }
    } catch {
        return $false
    } finally {
        $client.Close()
        $client.Dispose()
    }
}

function Invoke-SiYuanJsonApi {
    param(
        [string] $BaseUrl,
        [string] $Token,
        [string] $ApiPath,
        [string] $BodyJson,
        [string] $StageLabel
    )
    $uri = ($BaseUrl.TrimEnd("/") + $ApiPath)
    $headers = @{
        Authorization  = "Token $Token"
        "Content-Type" = "application/json"
    }
    try {
        $resp = Invoke-WebRequest -Uri $uri -Method POST -Headers $headers -Body $BodyJson -TimeoutSec 30
    } catch {
        # Never include response body / token / exception details that may carry secrets
        throw "stage=$StageLabel HTTP request failed"
    }
    $status = [int]$resp.StatusCode
    if ($status -lt 200 -or $status -ge 300) {
        throw "stage=$StageLabel HTTP status=$status"
    }
    try {
        $payload = $resp.Content | ConvertFrom-Json
    } catch {
        throw "stage=$StageLabel response is not JSON"
    }
    if ($null -eq $payload.code) {
        throw "stage=$StageLabel response missing code"
    }
    if ([int]$payload.code -ne 0) {
        throw "stage=$StageLabel API code=$([int]$payload.code)"
    }
    return $payload
}

function Invoke-GetWorkspaceInfo {
    param(
        [string] $BaseUrl,
        [string] $Token
    )
    $payload = Invoke-SiYuanJsonApi `
        -BaseUrl $BaseUrl `
        -Token $Token `
        -ApiPath "/api/system/getWorkspaceInfo" `
        -BodyJson "{}" `
        -StageLabel "workspace getWorkspaceInfo"
    if ($null -eq $payload.data -or $null -eq $payload.data.workspaceDir) {
        throw "stage=workspace getWorkspaceInfo data.workspaceDir missing"
    }
    $dir = [string]$payload.data.workspaceDir
    if ([string]::IsNullOrWhiteSpace($dir)) {
        throw "stage=workspace getWorkspaceInfo data.workspaceDir is empty"
    }
    return $dir
}

function Assert-RunningWorkspaceMatches {
    param(
        [string] $BaseUrl,
        [string] $Token,
        [string] $ExpectedWorkspace
    )
    $remoteDir = Invoke-GetWorkspaceInfo -BaseUrl $BaseUrl -Token $Token
    $left = [System.IO.Path]::GetFullPath($remoteDir.TrimEnd('\', '/'))
    $right = [System.IO.Path]::GetFullPath($ExpectedWorkspace.TrimEnd('\', '/'))
    $match = $false
    if ($IsWindows) {
        $match = [string]::Equals($left, $right, [System.StringComparison]::OrdinalIgnoreCase)
    } else {
        $match = ($left -eq $right)
    }
    if (-not $match) {
        throw "stage=workspace running instance workspaceDir does not match -Workspace (refusing before disable/swap)"
    }
}

function Invoke-SetPetalEnabled {
    param(
        [string] $BaseUrl,
        [string] $Token,
        [bool] $Enabled,
        [string] $AppId
    )
    $bodyObj = [ordered]@{
        packageName = $PluginName
        enabled     = $Enabled
        app         = $AppId
    }
    $body = $bodyObj | ConvertTo-Json -Compress
    $null = Invoke-SiYuanJsonApi `
        -BaseUrl $BaseUrl `
        -Token $Token `
        -ApiPath "/api/petal/setPetalEnabled" `
        -BodyJson $body `
        -StageLabel ("reload setPetalEnabled enabled={0}" -f $Enabled)
}

function Invoke-Pnpm {
    param([string[]] $PnpmArgs, [string] $Stage)
    Push-Location -LiteralPath $RepoRoot
    try {
        & pnpm @PnpmArgs
        if ($LASTEXITCODE -ne 0) {
            throw "stage=$Stage pnpm $($PnpmArgs -join ' ') failed exit=$LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}

function Test-ShouldReEnablePreviousPlugin {
    param(
        [bool] $HadExistingPlugin,
        [bool] $DisableAttempted,
        [bool] $BackupMoved,
        [bool] $NewInstalled,
        [bool] $BackupRestored,
        [string] $TargetPath
    )
    # Re-enable ONLY when identity of prior plugin at target is certain:
    #  (1) never moved and never replaced — old target still present; or
    #  (2) backup was successfully restored to target.
    # Never re-enable merely because target path exists (could be a failed new install).
    if (-not $HadExistingPlugin -or -not $DisableAttempted) {
        return $false
    }
    if ($BackupRestored) {
        return $true
    }
    if (-not $BackupMoved -and -not $NewInstalled -and (Test-Path -LiteralPath $TargetPath -PathType Container)) {
        return $true
    }
    return $false
}

# ---------------------------------------------------------------------------
# State (fine-grained machine — not a single $swapped flag)
# ---------------------------------------------------------------------------

$phase = "init"
$disableAttempted = $false
$existingDisabled = $false
$backupMoved = $false
$backupRestored = $false
$newInstalled = $false
$hadExistingPlugin = $false
$stagingPath = $null
$backupBase = $null
$backupRoot = $null
$backupPluginPath = $null
$failedPath = $null
$targetPath = $null
$pluginsDir = $null
$runGuid = [guid]::NewGuid().ToString("N")
$appId = "siyuanmaster-dev-local-$runGuid"
$stamp = Get-Date -Format "yyyyMMddHHmmss"
$tokenForEnv = $null
$previousTokenEnv = $null
$tokenEnvExistedBefore = $false
$tokenEnvMutated = $false
$apiOrigin = $null
$mcpUrl = $null
$apiUri = $null
$exitCode = 0

try {
    $phase = "validate"
    $resolvedApi = Resolve-StrictLoopbackOrigin -Url $ApiBaseUrl
    $apiUri = $resolvedApi.Uri
    $apiOrigin = $resolvedApi.Origin
    $mcpUrl = $resolvedApi.McpUrl

    if ($AllowRunningWithoutReload -and -not $SkipReload) {
        throw "stage=validate -AllowRunningWithoutReload requires -SkipReload"
    }

    if ([string]::IsNullOrWhiteSpace($Workspace)) {
        throw "stage=validate -Workspace is required"
    }
    $workspaceAbs = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Workspace)
    if (-not [System.IO.Path]::IsPathRooted($workspaceAbs)) {
        $workspaceAbs = Join-Path (Get-Location).Path $workspaceAbs
    }
    $workspaceAbs = [System.IO.Path]::GetFullPath($workspaceAbs)

    # Workspace must already exist and be a directory (WhatIf and real runs).
    if (-not (Test-Path -LiteralPath $workspaceAbs -PathType Container)) {
        throw "stage=validate Workspace must exist and be a directory: $workspaceAbs"
    }

    $dataDir = Join-Path $workspaceAbs "data"
    $pluginsDir = Join-Path $workspaceAbs "data\plugins"
    $targetPath = Join-Path $pluginsDir $PluginName
    # Enforce exact single install target (no wildcards / alternate names)
    $expectedTarget = [System.IO.Path]::GetFullPath((Join-Path $workspaceAbs "data\plugins\$PluginName"))
    if ($targetPath -ne $expectedTarget) {
        throw "stage=validate install target must be exactly <Workspace>/data/plugins/$PluginName"
    }

    # Read-only path safety: refuse junction/symlink escape on existing path segments.
    # WhatIf runs these checks too; never create directories here.
    Assert-ExistingPathNotReparse -Path $dataDir -Label "data"
    Assert-ExistingPathNotReparse -Path $pluginsDir -Label "data/plugins"
    Assert-ExistingPathNotReparse -Path $targetPath -Label "target ($PluginName)"

    # Explicit backup base: <Workspace>/data/plugins/.siyuanmaster-dev-backups
    $backupBase = Join-Path $pluginsDir ".siyuanmaster-dev-backups"
    $backupRoot = Join-Path $backupBase "$stamp-$runGuid"
    $backupPluginPath = Join-Path $backupRoot $PluginName
    # If backupBase already exists as junction/symlink, fail closed at validate (WhatIf too).
    Assert-ExistingPathNotReparse -Path $backupBase -Label "backupBase (.siyuanmaster-dev-backups)"

    Assert-PluginDist -Dir $DistDir -Context "dist"

    $stagingName = ".siyuanmaster-staging-$runGuid"
    $stagingPath = Join-Path $pluginsDir $stagingName
    $failedPath = Join-Path $backupBase ".quarantine-$runGuid"

    if ($WhatIf) {
        Write-Stage "whatif" "plan only — no build, API, TCP, mkdir, move, or env mutation"
        Write-Host "  repoRoot     = $RepoRoot"
        Write-Host "  distDir      = $DistDir"
        Write-Host "  workspace    = $workspaceAbs"
        Write-Host "  target       = $targetPath"
        Write-Host "  staging      = $stagingPath"
        Write-Host "  backup       = $backupPluginPath"
        Write-Host "  failedPath   = $failedPath"
        Write-Host "  apiOrigin    = $apiOrigin"
        Write-Host "  mcpUrl       = $mcpUrl"
        Write-Host "  confToken    = <Workspace>/conf/conf.json api.token (not read in WhatIf)"
        Write-Host "  skipBuild    = $SkipBuild"
        Write-Host "  skipReload   = $SkipReload"
        Write-Host "  allowRunningWithoutReload = $AllowRunningWithoutReload"
        Write-Host "  readSmoke    = $ReadSmoke"
        Write-Host "  appId        = $appId  (excludeApp only; not a login/caller identity)"
        if (-not $SkipBuild) {
            Write-Host "  step: pnpm build"
        } else {
            Write-Host "  step: skip build (use existing dist)"
        }
        Write-Host "  step: copy dist -> staging; re-verify (reject reparse points)"
        if ($SkipReload) {
            if ($AllowRunningWithoutReload) {
                Write-Host "  step: SkipReload + AllowRunningWithoutReload — install even if API port is open (RISK: running SiYuan may keep old plugin until restart)"
            } else {
                Write-Host "  step: TCP probe apiOrigin port; refuse install if reachable (unless AllowRunningWithoutReload)"
            }
            Write-Host "  step: Move-Item swap only; NO setPetalEnabled; NO MCP smoke"
            Write-Host "  step: print manual restart required"
        } else {
            Write-Host "  step: POST /api/system/getWorkspaceInfo {}; require workspaceDir match -Workspace (before disable/swap)"
            Write-Host "  step: disable petal (if existing install)"
            Write-Host "  step: Move-Item target->backup (if exists; name must be siyuanmaster), staging->target"
            Write-Host "  step: enable petal with app=$appId (excludeApp so PushReloadPlugin reaches real frontends)"
            if ($ReadSmoke) {
                Write-Host "  step: pnpm smoke:mcp --url `"$mcpUrl`" --read-smoke"
            } else {
                Write-Host "  step: pnpm smoke:mcp --url `"$mcpUrl`""
            }
        }
        Write-Stage "whatif" "OK"
        exit 0
    }

    # --- SkipReload: refuse when a process is listening unless explicitly allowed ---
    if ($SkipReload -and -not $AllowRunningWithoutReload) {
        $phase = "probe"
        Write-Stage "probe" "TCP check apiOrigin port (SkipReload without AllowRunningWithoutReload)"
        if (Test-TcpPortOpen -Uri $apiUri -TimeoutMs 400) {
            throw "stage=probe ApiBaseUrl port is reachable while -SkipReload is set; refuse install (running instance may keep old plugin). Re-run without SkipReload, or pass -AllowRunningWithoutReload if you accept the risk."
        }
        Write-Stage "probe" "port closed — OK for install-only"
    } elseif ($SkipReload -and $AllowRunningWithoutReload) {
        Write-Stage "probe" "skipped (AllowRunningWithoutReload — operator accepts running-instance risk)"
    }

    # --- build ---
    if (-not $SkipBuild) {
        $phase = "build"
        Write-Stage "build" "pnpm build"
        Invoke-Pnpm -PnpmArgs @("build") -Stage "build"
        Assert-PluginDist -Dir $DistDir -Context "dist-after-build"
    } else {
        Write-Stage "build" "skipped"
    }

    # Ensure plugins parent exists (never create the final target directly)
    if (-not (Test-Path -LiteralPath $pluginsDir -PathType Container)) {
        $null = New-Item -ItemType Directory -Path $pluginsDir -Force
    }

    $hadExistingPlugin = Test-Path -LiteralPath $targetPath -PathType Container
    if ($hadExistingPlugin -and (Test-IsReparsePoint -Path $targetPath)) {
        throw "stage=validate refusing reparse point (junction/symlink) for target ($PluginName): $targetPath"
    }
    if ($hadExistingPlugin) {
        Assert-ExistingTargetIsSiYuanMasterPlugin -TargetDir $targetPath
    }

    # --- stage ---
    $phase = "stage"
    Write-Stage "stage" "copy dist -> staging"
    Copy-DistToStaging -SourceDist $DistDir -StagingPath $stagingPath

    # backupRoot only when replacing an existing install — no empty backup dir on fresh install
    if ($hadExistingPlugin) {
        # TOCTOU: re-check backupBase / backupRoot and any already-existing parents before mkdir.
        Assert-ExistingPathNotReparse -Path $backupBase -Label "backupBase (.siyuanmaster-dev-backups)"
        Assert-ExistingPathNotReparse -Path $backupRoot -Label "backupRoot"
        Assert-ExistingParentsNotReparse -Path $backupBase -Label "backupBase"
        Assert-ExistingParentsNotReparse -Path $backupRoot -Label "backupRoot"
        $null = New-Item -ItemType Directory -Path $backupRoot -Force
    }

    # --- token + running-instance workspace match (only when reload/smoke needed) ---
    if (-not $SkipReload) {
        $phase = "token"
        $tokenForEnv = Read-WorkspaceApiToken -WorkspaceRoot $workspaceAbs
        # Precise restore: record whether env var existed (empty string is still "existed")
        $tokenEnvExistedBefore = Test-Path Env:SIYUAN_API_TOKEN
        if ($tokenEnvExistedBefore) {
            $previousTokenEnv = [string]$env:SIYUAN_API_TOKEN
        } else {
            $previousTokenEnv = $null
        }
        $env:SIYUAN_API_TOKEN = $tokenForEnv
        $tokenEnvMutated = $true
        Write-Stage "token" "loaded into process env (not printed)"

        $phase = "workspace"
        Write-Stage "workspace" "getWorkspaceInfo must match -Workspace (before disable/swap)"
        Assert-RunningWorkspaceMatches -BaseUrl $apiOrigin -Token $tokenForEnv -ExpectedWorkspace $workspaceAbs
        Write-Stage "workspace" "OK"
    }

    # --- disable existing (only when present) ---
    if (-not $SkipReload) {
        if ($hadExistingPlugin) {
            $phase = "disable"
            Write-Stage "disable" "setPetalEnabled enabled=false"
            $disableAttempted = $true
            Invoke-SetPetalEnabled -BaseUrl $apiOrigin -Token $tokenForEnv -Enabled $false -AppId $appId
            $existingDisabled = $true
        } else {
            Write-Stage "disable" "skipped (no existing install at target)"
        }
    }

    # --- swap via Move-Item only ---
    $phase = "swap"
    Write-Stage "swap" "Move-Item exchange"
    if ($hadExistingPlugin) {
        if (Test-Path -LiteralPath $backupPluginPath) {
            throw "stage=swap backup destination already exists: $backupPluginPath"
        }
        Move-Item -LiteralPath $targetPath -Destination $backupPluginPath
        $backupMoved = $true

        if ($TestFailAfterBackupMove) {
            throw "stage=swap TestFailAfterBackupMove: intentional test failure after backup move"
        }
    }
    if (Test-Path -LiteralPath $targetPath) {
        throw "stage=swap target still exists after backup move: $targetPath"
    }
    if (Test-Path -LiteralPath $failedPath) {
        throw "stage=swap failed-path name already exists: $failedPath"
    }
    Move-Item -LiteralPath $stagingPath -Destination $targetPath
    $newInstalled = $true
    $stagingPath = $null  # moved
    Assert-PluginDist -Dir $targetPath -Context "target-after-swap"
    Write-Stage "swap" "OK target=$targetPath"

    if ($TestFailAfterSwap) {
        throw "stage=swap TestFailAfterSwap: intentional test failure after new install"
    }

    if ($SkipReload) {
        Write-Stage "reload" "skipped"
        Write-Host "[dev-local] manual restart required (SkipReload: SiYuan not running or operator will restart manually)"
        Write-Stage "smoke" "skipped (SkipReload)"
        Write-Stage "done" "install-only complete"
        if ($hadExistingPlugin) {
            Write-Host "[dev-local] backup=$backupPluginPath"
        } else {
            Write-Host "[dev-local] backup=none (no prior install)"
        }
        Write-Host "[dev-local] target=$targetPath"
        exit 0
    }

    # --- enable + smoke ---
    $phase = "enable"
    Write-Stage "enable" "setPetalEnabled enabled=true app=$appId (excludeApp only)"
    Invoke-SetPetalEnabled -BaseUrl $apiOrigin -Token $tokenForEnv -Enabled $true -AppId $appId

    $phase = "smoke"
    if ($ReadSmoke) {
        Write-Stage "smoke" "pnpm smoke:mcp --url $mcpUrl --read-smoke"
        Invoke-Pnpm -PnpmArgs @("smoke:mcp", "--url", $mcpUrl, "--read-smoke") -Stage "smoke"
    } else {
        Write-Stage "smoke" "pnpm smoke:mcp --url $mcpUrl"
        Invoke-Pnpm -PnpmArgs @("smoke:mcp", "--url", $mcpUrl) -Stage "smoke"
    }

    $phase = "done"
    Write-Stage "done" "PASS"
    Write-Host "[dev-local] target=$targetPath"
    if ($hadExistingPlugin) {
        Write-Host "[dev-local] backup=$backupPluginPath"
    } else {
        Write-Host "[dev-local] backup=none (no prior install)"
    }
    Write-Host "[dev-local] stages=build/stage/swap/enable/smoke OK"
}
catch {
    $exitCode = 1
    $errMsg = $_.Exception.Message
    if ([string]::IsNullOrWhiteSpace($errMsg)) {
        $errMsg = "$_"
    }
    # Redact accidental token leakage if any
    if ($tokenForEnv -and $errMsg.Contains($tokenForEnv)) {
        $errMsg = $errMsg.Replace($tokenForEnv, "[REDACTED_TOKEN]")
    }
    Write-Host "[dev-local] FAIL phase=$phase $errMsg" -ForegroundColor Red

    $recoverErrors = [System.Collections.Generic.List[string]]::new()
    $recoveryTouched = $false

    # --- newInstalled: best-effort disable new plugin, then move target to unique failedPath ---
    if ($newInstalled) {
        $recoveryTouched = $true
        Write-Stage "recover" "newInstalled — disabling new plugin and quarantining target"

        if (-not $SkipReload -and $tokenForEnv) {
            try {
                Invoke-SetPetalEnabled -BaseUrl $apiOrigin -Token $tokenForEnv -Enabled $false -AppId $appId
                Write-Stage "recover" "disabled new plugin"
            } catch {
                $recoverErrors.Add("disable-new failed")
                Write-Stage "recover" "disable-new failed (continuing)"
            }
        }

        try {
            if ($TestFailQuarantine) {
                $recoverErrors.Add("quarantine forced fail (TestFailQuarantine); target retained=$targetPath")
                Write-Stage "recover" "TestFailQuarantine: leaving failed new target in place"
            } elseif (Test-Path -LiteralPath $targetPath) {
                if (Test-Path -LiteralPath $failedPath) {
                    $recoverErrors.Add("failed-path already exists: $failedPath")
                    Write-Stage "recover" "cannot move failed target; path retained target=$targetPath failedPath=$failedPath"
                } else {
                    # TOCTOU revalidation: backupBase (failedPath parent) could have been swapped to a junction/symlink
                    # between initial validation and recovery. Re-check to prevent quarantining outside the workspace.
                    $failedParent = [System.IO.Path]::GetDirectoryName($failedPath)
                    if ($failedParent) {
                        Assert-ExistingPathNotReparse -Path $failedParent -Label "failedParent (backupBase)"
                        Assert-ExistingParentsNotReparse -Path $failedParent -Label "failedParent"
                    }
                    if ($failedParent -and -not (Test-Path -LiteralPath $failedParent -PathType Container)) {
                        $null = New-Item -ItemType Directory -Path $failedParent -Force
                    }
                    Move-Item -LiteralPath $targetPath -Destination $failedPath
                    Write-Stage "recover" "moved failed target -> $failedPath"
                }
            }
        } catch {
            $recoverErrors.Add("move-failed-target failed; target retained=$targetPath")
            Write-Stage "recover" "move-failed-target failed; retained target=$targetPath"
        }
    }

    # --- backupMoved: restore backup to official target when free (incl. newInstalled=false) ---
    if ($backupMoved) {
        $recoveryTouched = $true
        Write-Stage "recover" "backupMoved — restoring prior install when target is free"
        try {
            if (-not (Test-Path -LiteralPath $targetPath) -and (Test-Path -LiteralPath $backupPluginPath)) {
                Move-Item -LiteralPath $backupPluginPath -Destination $targetPath
                $backupRestored = $true
                Write-Stage "recover" "restored backup -> target"
            } elseif (Test-Path -LiteralPath $targetPath) {
                $recoverErrors.Add("target still occupied; backup retained=$backupPluginPath")
                Write-Stage "recover" "target still occupied; backup retained=$backupPluginPath"
            } else {
                $recoverErrors.Add("backup missing; cannot restore")
                Write-Stage "recover" "backup missing; cannot restore"
            }
        } catch {
            $recoverErrors.Add("restore-backup failed; backup retained=$backupPluginPath")
            Write-Stage "recover" "restore-backup failed; backup retained=$backupPluginPath"
        }
    }

    # --- Re-enable prior plugin (identity-safe only) ---
    # Allowed only when:
    #   backupMoved=false AND newInstalled=false AND old target still exists; OR
    #   backupRestored=true
    # Never re-enable solely because target exists (failed new install must not be enabled).
    if ($hadExistingPlugin -and $disableAttempted) {
        $recoveryTouched = $true
        $shouldReEnable = Test-ShouldReEnablePreviousPlugin `
            -HadExistingPlugin $hadExistingPlugin `
            -DisableAttempted $disableAttempted `
            -BackupMoved $backupMoved `
            -NewInstalled $newInstalled `
            -BackupRestored $backupRestored `
            -TargetPath $targetPath

        if ($shouldReEnable) {
            if (-not $SkipReload -and $tokenForEnv) {
                try {
                    Invoke-SetPetalEnabled -BaseUrl $apiOrigin -Token $tokenForEnv -Enabled $true -AppId $appId
                    Write-Stage "recover" "re-enabled previous plugin"
                } catch {
                    $recoverErrors.Add("re-enable previous plugin failed")
                    Write-Stage "recover" "re-enable previous plugin failed"
                }
            } else {
                Write-Stage "recover" "previous plugin identity OK at target; re-enable skipped (SkipReload or no token)"
            }
        } else {
            # Explicit incomplete recovery when we disabled prior install but cannot prove restore
            $recoverErrors.Add("re-enable forbidden: prior plugin identity not restored (backupRestored=$backupRestored backupMoved=$backupMoved newInstalled=$newInstalled)")
            Write-Stage "recover" "re-enable forbidden — recover incomplete (failed new target isolation and/or backup not restored)"
        }
    } elseif (-not $hadExistingPlugin -and $newInstalled) {
        Write-Stage "recover" "no prior install — not fabricating restore"
    } elseif (-not $recoveryTouched) {
        # No install/swap progress that needs rollback — retain staging only
        Write-Stage "recover" "no swap progress — retaining staging (no recursive delete)"
    }

    # Always report retained paths (fail closed; never recursive-delete)
    if ($stagingPath -and (Test-Path -LiteralPath $stagingPath)) {
        Write-Host "[dev-local] staging retained=$stagingPath"
    }
    Write-Host "[dev-local] recover retained paths:"
    if ($null -ne $failedPath -and (Test-Path -LiteralPath $failedPath)) {
        Write-Host "  failed=$failedPath"
    }
    if ($null -ne $backupPluginPath -and (Test-Path -LiteralPath $backupPluginPath)) {
        Write-Host "  backup=$backupPluginPath"
    }
    if ($null -ne $backupRoot -and (Test-Path -LiteralPath $backupRoot)) {
        Write-Host "  backupRoot=$backupRoot"
    }
    if ($null -ne $targetPath -and (Test-Path -LiteralPath $targetPath)) {
        Write-Host "  target=$targetPath"
    }
    if ($recoverErrors.Count -gt 0) {
        Write-Host "[dev-local] recover incomplete: $($recoverErrors -join '; ')"
    }

    exit $exitCode
}
finally {
    # Restore SIYUAN_API_TOKEN precisely: empty string that existed is restored as empty;
    # only Remove-Item when the variable did not exist before mutation.
    if ($tokenEnvMutated) {
        if ($tokenEnvExistedBefore) {
            $env:SIYUAN_API_TOKEN = $previousTokenEnv
        } else {
            Remove-Item Env:SIYUAN_API_TOKEN -ErrorAction SilentlyContinue
        }
    }
    # Clear local secret refs
    $tokenForEnv = $null
}
