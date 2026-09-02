param(
  [string]$OutputDirectory = 'dist'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$outputRoot = Join-Path $repositoryRoot $OutputDirectory
$packageName = 'kaven-dns-openwrt-arm64'
$packageRoot = Join-Path $outputRoot $packageName
$archivePath = Join-Path $outputRoot "$packageName.tar.gz"
$checksumPath = "$archivePath.sha256"

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
  & $goExecutable build -trimpath -ldflags '-s -w' -o (Join-Path $packageRoot 'kaven-dns') ./cmd/kaven-dns
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
Write-Host "SHA-256: $hash"
