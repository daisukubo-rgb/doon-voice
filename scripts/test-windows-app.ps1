#Requires -Version 7.0
param([Parameter(Mandatory)][string]$Directory)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$executable = Join-Path $Directory 'doon-voice-desktop.exe'
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "The MSI does not contain the desktop executable: $executable"
}
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
# Consume native output before selecting a line. Select-Object -First can stop
# the native pipeline early, before PowerShell assigns LASTEXITCODE.
$visualStudioPaths = @(& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
if ($LASTEXITCODE -ne 0) { throw 'Visual Studio dependency inspection is unavailable.' }
$visualStudio = $visualStudioPaths | Select-Object -First 1
if (-not $visualStudio) { throw 'Visual Studio dependency inspection is unavailable.' }
$toolset = Get-ChildItem -LiteralPath (Join-Path $visualStudio 'VC/Tools/MSVC') -Directory | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
$dumpbin = Join-Path $toolset.FullName 'bin/Hostx64/x64/dumpbin.exe'
$imports = (& $dumpbin /DEPENDENTS $executable | Out-String)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect desktop executable imports.' }
if ($imports -match '(?im)^\s*(vcruntime\S*|msvc[pr]\S*|vcomp\S*)\.dll\s*$') {
    throw "The desktop executable requires an external VC runtime: $imports"
}
Write-Host $imports

$application = Start-Process -FilePath $executable -WorkingDirectory $Directory -PassThru
try {
    if (-not $application.WaitForInputIdle(20000)) { throw 'The desktop application did not initialize its window.' }
    Start-Sleep -Seconds 5
    $application.Refresh()
    if ($application.HasExited) { throw "The desktop application exited unexpectedly: $($application.ExitCode)" }
    if ($application.MainWindowHandle -eq 0 -or $application.MainWindowTitle -ne 'DOON Voice') {
        throw "The desktop window was not found: $($application.MainWindowTitle)"
    }
    Write-Host 'PASS: MSI内のWindowsアプリが起動し、DOON Voiceウィンドウを表示しました。'
} finally {
    if (-not $application.HasExited) {
        # The application intentionally stays in the tray when its window closes.
        # Stop only the process this isolated test just created.
        Stop-Process -Id $application.Id -Force
        $application.WaitForExit(10000) | Out-Null
    }
    $application.Dispose()
}
