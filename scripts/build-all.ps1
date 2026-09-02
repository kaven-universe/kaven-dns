param(
  [string]$OutputDirectory = 'dist/releases',
  [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDirectory)) { $OutputDirectory } else { Join-Path $repositoryRoot $OutputDirectory }
if (-not $Version) {
  $Version = (Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'VERSION')).Trim()
}
if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._+-]*$') {
  throw "Invalid version: $Version"
}
$fileVersion = $Version -replace '[^0-9A-Za-z._-]', '-'

$goCommand = Get-Command go -ErrorAction SilentlyContinue
if ($goCommand) {
  $goExecutable = $goCommand.Source
} elseif (Test-Path -LiteralPath 'C:\Program Files\Go\bin\go.exe') {
  $goExecutable = 'C:\Program Files\Go\bin\go.exe'
} else {
  throw 'Go was not found in PATH or its standard Windows installation directory.'
}

$commit = ''
if (Get-Command git -ErrorAction SilentlyContinue) {
  $commit = (& git -C $repositoryRoot rev-parse --short=12 HEAD 2>$null)
  if ($LASTEXITCODE -ne 0) {
    $commit = ''
  }
}
$linkerFlags = "-s -w -X kaven.xyz/kaven/kaven-dns/internal/buildinfo.Version=$Version"
if ($commit) {
  $linkerFlags += " -X kaven.xyz/kaven/kaven-dns/internal/buildinfo.Commit=$commit"
}

$targets = @(
  @{ OS = 'linux'; Arch = 'amd64' },
  @{ OS = 'linux'; Arch = 'arm64' },
  @{ OS = 'windows'; Arch = 'amd64' },
  @{ OS = 'windows'; Arch = 'arm64' },
  @{ OS = 'darwin'; Arch = 'amd64' },
  @{ OS = 'darwin'; Arch = 'arm64' }
)

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$oldCgoEnabled, $oldGoOS, $oldGoArch, $oldGoArm64 = $env:CGO_ENABLED, $env:GOOS, $env:GOARCH, $env:GOARM64
$checksums = [System.Collections.Generic.List[string]]::new()
try {
  $env:CGO_ENABLED = '0'
  foreach ($target in $targets) {
    $env:GOOS = $target.OS
    $env:GOARCH = $target.Arch
    $env:GOARM64 = if ($target.Arch -eq 'arm64') { 'v8.0' } else { $null }
    $extension = if ($target.OS -eq 'windows') { '.exe' } else { '' }
    $name = "kaven-dns_${fileVersion}_$($target.OS)_$($target.Arch)$extension"
    $path = Join-Path $outputRoot $name
    & $goExecutable build -trimpath -ldflags $linkerFlags -o $path ./cmd/kaven-dns
    if ($LASTEXITCODE -ne 0) {
      throw "go build failed for $($target.OS)/$($target.Arch) with exit code $LASTEXITCODE"
    }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
    $checksums.Add("$hash  $name")
    Write-Host "Created $name"
  }
} finally {
  $env:CGO_ENABLED, $env:GOOS, $env:GOARCH, $env:GOARM64 = $oldCgoEnabled, $oldGoOS, $oldGoArch, $oldGoArm64
}

& (Join-Path $PSScriptRoot 'build-router.ps1') -OutputDirectory $outputRoot -Version $Version
$routerName = "kaven-dns_${fileVersion}_openwrt_arm64.tar.gz"
$routerPath = Join-Path $outputRoot $routerName
$routerHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $routerPath).Hash.ToLowerInvariant()
$checksums.Add("$routerHash  $routerName")
$checksums | Sort-Object | Set-Content -LiteralPath (Join-Path $outputRoot 'SHA256SUMS') -Encoding ascii

Write-Host "Created all release targets in $outputRoot"
