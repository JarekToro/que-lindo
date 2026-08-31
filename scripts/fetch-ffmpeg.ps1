# Downloads static ffmpeg + ffprobe (gyan.dev release essentials) into
# app/src-tauri/binaries/ with the Tauri sidecar target-triple names.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dest = Join-Path $root "app\src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$triple = "x86_64-pc-windows-msvc"

$tmp = Join-Path $env:TEMP ("ffmpeg-fetch-" + [System.Guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
    $zip = Join-Path $tmp "ffmpeg.zip"
    Write-Host "downloading ffmpeg (gyan.dev release-essentials) ..."
    Invoke-WebRequest -Uri "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $tmp
    $bin = Get-ChildItem -Path $tmp -Recurse -Directory | Where-Object { $_.Name -eq "bin" } | Select-Object -First 1
    Copy-Item (Join-Path $bin.FullName "ffmpeg.exe") (Join-Path $dest "ffmpeg-$triple.exe") -Force
    Copy-Item (Join-Path $bin.FullName "ffprobe.exe") (Join-Path $dest "ffprobe-$triple.exe") -Force
    foreach ($tool in @("ffmpeg", "ffprobe")) {
        $out = Join-Path $dest "$tool-$triple.exe"
        if (-not (Test-Path $out)) { throw "$out was not created" }
    }
    Write-Host "done:"
    Get-ChildItem $dest
    Write-Host "`nnote: bundled ffmpeg builds are GPL-licensed - keep the attribution if you distribute the app."
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
