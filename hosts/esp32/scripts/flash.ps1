param(
    [string]$Port = "COM13"
)

$ErrorActionPreference = "Stop"
$HostRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Pio = Join-Path $env:USERPROFILE ".platformio\penv\Scripts\pio.exe"
if (-not (Test-Path -LiteralPath $Pio)) {
    throw "PlatformIO was not found at $Pio"
}
if (-not ([System.IO.Ports.SerialPort]::GetPortNames() -contains $Port)) {
    throw "Serial port $Port is not present."
}

& $Pio run -d $HostRoot -e symbian_pocket -t upload --upload-port $Port
if ($LASTEXITCODE -ne 0) {
    throw "Firmware upload failed with exit code $LASTEXITCODE."
}

& (Join-Path $env:USERPROFILE ".platformio\penv\Scripts\python.exe") `
    (Join-Path $PSScriptRoot "validate_firmware.py") --port $Port
if ($LASTEXITCODE -ne 0) {
    throw "On-device validation failed with exit code $LASTEXITCODE."
}
