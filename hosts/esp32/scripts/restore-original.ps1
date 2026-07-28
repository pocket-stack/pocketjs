param(
    [string]$Port = "COM13",
    [string]$Backup = "D:\ESP32\XuErSi\backups\before_symbian_pocket_probe_20260727_234359_4mb.bin"
)

$ErrorActionPreference = "Stop"
$Esptool = Join-Path $env:USERPROFILE ".platformio\packages\tool-esptoolpy\esptool.py"
$Python = Join-Path $env:USERPROFILE ".platformio\penv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $Backup)) {
    throw "Backup image was not found: $Backup"
}
if ((Get-Item -LiteralPath $Backup).Length -ne 4194304) {
    throw "The restore image must be exactly 4 MiB."
}
$Expected = "36AD56830B0D386EE03F192F979C92FA7D909A265FD7D0022937D0F45F74B039"
$Actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Backup).Hash
if ($Actual -ne $Expected) {
    throw "Backup SHA-256 mismatch: $Actual"
}

& $Python $Esptool --chip esp32 --port $Port --baud 460800 `
    write_flash --flash_mode dio --flash_freq 40m --flash_size 4MB 0x0 $Backup
if ($LASTEXITCODE -ne 0) {
    throw "Restore failed with exit code $LASTEXITCODE."
}
