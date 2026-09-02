param(
  [string]$OutputDirectory = 'dist',
  [string]$Version = '',
  [ValidateSet('arm64', 'armv7')]
  [string]$Architecture = 'arm64'
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
$packageName = "kaven-dns_${fileVersion}_openwrt_$Architecture"
$packageRoot = Join-Path $outputRoot $packageName
$archivePath = Join-Path $outputRoot "$packageName.tar.gz"
$checksumPath = "$archivePath.sha256"

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
$oldGoArm = $env:GOARM
$oldGoArm64 = $env:GOARM64
try {
  $env:CGO_ENABLED = '0'
  $env:GOOS = 'linux'
  $env:GOARCH = if ($Architecture -eq 'armv7') { 'arm' } else { 'arm64' }
  $env:GOARM = if ($Architecture -eq 'armv7') { '7' } else { $null }
  $env:GOARM64 = if ($Architecture -eq 'arm64') { 'v8.0' } else { $null }
  & $goExecutable build -trimpath -ldflags $linkerFlags -o (Join-Path $packageRoot 'kaven-dns') ./cmd/kaven-dns
  if ($LASTEXITCODE -ne 0) {
    throw "go build failed with exit code $LASTEXITCODE"
  }
} finally {
  $env:CGO_ENABLED = $oldCgoEnabled
  $env:GOOS = $oldGoOS
  $env:GOARCH = $oldGoArch
  $env:GOARM = $oldGoArm
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
