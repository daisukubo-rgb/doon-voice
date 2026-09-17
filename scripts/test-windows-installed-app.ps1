#Requires -Version 7.0
param([Parameter(Mandatory)][string]$Installer)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) {
    throw "MSIが見つかりません: $Installer"
}

$installDirectory = Join-Path $env:ProgramFiles 'DOON Voice'
$installed = $false

function Invoke-Msi([string[]]$Arguments, [string]$Operation) {
    $argumentLine = ($Arguments | ForEach-Object {
        if ($_ -match '[\s"]') {
            '"' + $_.Replace('"', '\\"') + '"'
        } else {
            $_
        }
    }) -join ' '
    $process = Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" -ArgumentList $argumentLine -Wait -PassThru
    $exitCode = $process.ExitCode
    if ($exitCode -notin @(0, 3010)) {
        throw "$Operation に失敗しました (msiexec exit code: $exitCode)"
    }
}

try {
    Invoke-Msi -Arguments @('/i', $Installer, '/qn', '/norestart') -Operation 'MSIのインストール'
    $installed = $true
    if (-not (Test-Path -LiteralPath $installDirectory -PathType Container)) {
        throw "MSIのインストール先が見つかりません: $installDirectory"
    }
    & $PSScriptRoot/test-windows-app.ps1 -Directory $installDirectory
    Write-Host 'PASS: MSIを実際にインストールしてDOON Voiceを起動しました。'
} finally {
    if ($installed) {
        Invoke-Msi -Arguments @('/x', $Installer, '/qn', '/norestart') -Operation 'MSIのアンインストール'
        $deadline = (Get-Date).AddSeconds(30)
        while ((Test-Path -LiteralPath $installDirectory) -and (Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 1
        }
        if (Test-Path -LiteralPath $installDirectory) {
            throw "アンインストール後もアプリ本体が残っています: $installDirectory"
        }
        Write-Host 'PASS: テスト用に導入したDOON Voiceをアンインストールしました。'
    }
}
