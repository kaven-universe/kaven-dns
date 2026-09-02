param(
  [string]$OutputDirectory = 'dist',
  [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$outputRoot = Join-Path $repositoryRoot $OutputDirectory
$packageName = 'kaven-dns-openwrt-arm64'
$packageRoot = Join-Path $outputRoot $packageName
$archivePath = Join-Path $outputRoot "$packageName.tar.gz"
$checksumPath = "$archivePath.sha256"

if (-not $Version) {
  $manifest = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'package.json') | ConvertFrom-Json
  $Version = "$($manifest.version)-go"
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

$goCommand = Get-Command go -ErrorAction SilentlyContinue
if ($goCommand) {
  $goExecutable = $goCommand.Source
} elseif (Test-Path -LiteralPath 'C:\Program Files\Go\bin\go.exe') {
  $goExecutable = 'C:\Program Files\Go\bin\go.exe'
} else {
  throw 'Go was not found in PATH or its standard Windows installation directory.'
}
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
  throw 'tar was not found in PATH.'
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
if (Test-Path -LiteralPath $packageRoot) {
  Remove-Item -LiteralPath $packageRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $packageRoot | Out-Null

$oldCgoEnabled = $env:CGO_ENABLED
$oldGoOS = $env:GOOS
$oldGoArch = $env:GOARCH
$oldGoArm64 = $env:GOARM64
try {
  $env:CGO_ENABLED = '0'
  $env:GOOS = 'linux'
  $env:GOARCH = 'arm64'
  $env:GOARM64 = 'v8.0'
  & $goExecutable build -trimpath -ldflags $linkerFlags -o (Join-Path $packageRoot 'kaven-dns') ./cmd/kaven-dns
  if ($LASTEXITCODE -ne 0) {
    throw "go build failed with exit code $LASTEXITCODE"
  }
} finally {
  $env:CGO_ENABLED = $oldCgoEnabled
  $env:GOOS = $oldGoOS
  $env:GOARCH = $oldGoArch
  $env:GOARM64 = $oldGoArm64
}

Copy-Item (Join-Path $repositoryRoot 'deploy/openwrt/*') $packageRoot
if (Test-Path -LiteralPath $archivePath) {
  Remove-Item -LiteralPath $archivePath -Force
}
& tar -czf $archivePath -C $outputRoot $packageName
if ($LASTEXITCODE -ne 0) {
  throw "tar failed with exit code $LASTEXITCODE"
}

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
Set-Content -LiteralPath $checksumPath -Value "$hash  $packageName.tar.gz" -Encoding ascii

Write-Host "Created $archivePath"
Write-Host "Version: $Version"
Write-Host "SHA-256: $hash"
