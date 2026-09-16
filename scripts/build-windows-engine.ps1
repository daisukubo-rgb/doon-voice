#Requires -Version 7.0
<#
.SYNOPSIS
Build the pinned Windows x64 Whisper engine without redistributable DLLs.
.EXAMPLE
pwsh -File scripts/build-windows-engine.ps1
.EXAMPLE
pwsh -File scripts/build-windows-engine.ps1 -Variant avx2
#>
[CmdletBinding()]
param(
    [string]$WorkDirectory = '',
    [ValidateRange(1, 64)]
    [int]$Jobs = 4,
    [ValidateSet('compatible', 'avx2')]
    [string]$Variant = 'compatible'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Check native exit codes explicitly, including on PowerShell 7.3+.
$PSNativeCommandUseErrorActionPreference = $false

if (-not $IsWindows) { throw 'This build requires Windows and Visual Studio 2022 C++ tools.' }
$Variant = $Variant.ToLowerInvariant()

function Invoke-CheckedNative {
    param([string]$FilePath, [string[]]$ArgumentList)
    $output = & $FilePath @ArgumentList 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        $output | ForEach-Object { Write-Host $_ }
        throw "Native command failed with exit code ${exitCode}: $FilePath $($ArgumentList -join ' ')"
    }
    return $output
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$version = '1.9.2'
$archiveUrl = "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v$version.tar.gz"
$archiveSha256 = 'a6abd064fcca8b85e794d205abf328c522e9451db43a3eadc178b883b7d0e9cd'
$cmake = (Get-Command cmake -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$tar = (Get-Command tar.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) { throw 'Visual Studio Installer/vswhere.exe is required.' }
$visualStudio = (Invoke-CheckedNative $vswhere @(
    '-latest', '-products', '*', '-version', '[17.0,18.0)',
    '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'
) | Out-String).Trim()
if (-not $visualStudio) { throw 'Visual Studio 2022 with the x64 C++ toolchain was not found.' }
$toolsets = @(Get-ChildItem -LiteralPath (Join-Path $visualStudio 'VC/Tools/MSVC') -Directory |
    Sort-Object { [version]$_.Name } -Descending)
if ($toolsets.Count -eq 0) { throw 'The MSVC toolchain directory is empty.' }
$dumpbin = Join-Path $toolsets[0].FullName 'bin/Hostx64/x64/dumpbin.exe'
if (-not (Test-Path -LiteralPath $dumpbin -PathType Leaf)) { throw 'The x64 dumpbin.exe was not found.' }

if (-not $WorkDirectory) {
    $WorkDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("doon-whisper-windows-" + [guid]::NewGuid().ToString('N'))
}
$WorkDirectory = [System.IO.Path]::GetFullPath($WorkDirectory)
# A fresh directory prevents an old CMake cache or executable from being accepted.
if (Test-Path -LiteralPath $WorkDirectory) { throw "WorkDirectory must not already exist: $WorkDirectory" }
New-Item -ItemType Directory -Path $WorkDirectory | Out-Null
Write-Host "Build evidence: $WorkDirectory"

$archive = Join-Path $WorkDirectory "whisper-v$version.tar.gz"
Invoke-WebRequest -Uri $archiveUrl -OutFile $archive -TimeoutSec 180 -MaximumRetryCount 3 -RetryIntervalSec 2
$actualArchiveSha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualArchiveSha256 -ne $archiveSha256) { throw "Whisper archive SHA-256 mismatch: $actualArchiveSha256" }
Invoke-CheckedNative $tar @('-xzf', $archive, '-C', $WorkDirectory)
$source = Join-Path $WorkDirectory "whisper.cpp-$version"
$build = Join-Path $WorkDirectory 'build'
if (-not (Test-Path -LiteralPath (Join-Path $source 'CMakeLists.txt') -PathType Leaf)) {
    throw 'The verified archive did not contain the expected Whisper source directory.'
}

$options = [ordered]@{
    CMAKE_BUILD_TYPE = 'Release'
    # Whisper's top-level minimum is 3.5. Set CMP0091 before its first project()
    # so CMAKE_MSVC_RUNTIME_LIBRARY applies to Whisper, common and nested GGML.
    CMAKE_POLICY_DEFAULT_CMP0091 = 'NEW'
    CMAKE_MSVC_RUNTIME_LIBRARY = 'MultiThreaded'
    CMAKE_GENERATOR_INSTANCE = $visualStudio
    BUILD_SHARED_LIBS = 'OFF'
    GGML_BACKEND_DL = 'OFF'
    GGML_STATIC = 'OFF'
    GGML_NATIVE = 'OFF'
    GGML_CPU_ALL_VARIANTS = 'OFF'
    GGML_SSE42 = 'ON'
    GGML_AVX = 'OFF'
    GGML_AVX2 = 'OFF'
    GGML_AVX_VNNI = 'OFF'
    GGML_AVX512 = 'OFF'
    GGML_AVX512_VBMI = 'OFF'
    GGML_AVX512_VNNI = 'OFF'
    GGML_AVX512_BF16 = 'OFF'
    GGML_BMI2 = 'OFF'
    # MSVC derives FMA/F16C from AVX2; the avx2 variant enables them below.
    GGML_OPENMP = 'OFF'
    GGML_BLAS = 'OFF'
    GGML_METAL = 'OFF'
    GGML_CUDA = 'OFF'
    GGML_VULKAN = 'OFF'
    GGML_SYCL = 'OFF'
    WHISPER_BUILD_TESTS = 'OFF'
    WHISPER_BUILD_SERVER = 'OFF'
    # whisper-cli lives under examples/. Only the CLI target is built below.
    WHISPER_BUILD_EXAMPLES = 'ON'
    WHISPER_SDL2 = 'OFF'
    WHISPER_COMMON_FFMPEG = 'OFF'
}
$binaryRelativePath = 'src-tauri/binaries/whisper-cli-x86_64-pc-windows-msvc.exe'
$manifestRelativePath = 'src-tauri/resources/engine/windows-build.json'
$cpuRequirements = @('sse4.2')
if ($Variant -eq 'avx2') {
    $options.GGML_AVX = 'ON'
    $options.GGML_AVX2 = 'ON'
    # GGML's BMI2 kernels remain disabled in both variants.
    $cpuRequirements = @('sse4.2', 'avx', 'avx2', 'fma', 'f16c')
    $binaryRelativePath = 'src-tauri/resources/engine/windows-x64/whisper/whisper-avx2.exe'
    $manifestRelativePath = 'src-tauri/resources/engine/windows-avx2-build.json'
}
Write-Host "Variant: $Variant; CPU requirements: $($cpuRequirements -join ', ')"
$configureArguments = @('-S', $source, '-B', $build, '-G', 'Visual Studio 17 2022', '-A', 'x64')
foreach ($entry in $options.GetEnumerator()) { $configureArguments += "-D$($entry.Key)=$($entry.Value)" }
Invoke-CheckedNative $cmake $configureArguments | Tee-Object -FilePath (Join-Path $WorkDirectory 'configure.log')
Invoke-CheckedNative $cmake @('--build', $build, '--config', 'Release', '--target', 'whisper-cli', '--parallel', "$Jobs") |
    Tee-Object -FilePath (Join-Path $WorkDirectory 'build.log')

$engine = Join-Path $build 'bin/Release/whisper-cli.exe'
if (-not (Test-Path -LiteralPath $engine -PathType Leaf)) { throw 'The build did not produce whisper-cli.exe.' }
$dependenciesOutput = (Invoke-CheckedNative $dumpbin @('/DEPENDENTS', $engine) | Out-String)
$dependenciesOutput | Set-Content -LiteralPath (Join-Path $WorkDirectory 'dependents.log') -Encoding utf8
$dependencies = @([regex]::Matches($dependenciesOutput, '(?im)^\s*([a-z0-9_.-]+\.dll)\s*$') |
    ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
if ($dependencies.Count -eq 0) { throw 'dumpbin did not report any DLL imports; dependency verification is inconclusive.' }
$forbiddenDependencies = @($dependencies | Where-Object { $_ -match '^(whisper|ggml|vcomp|msvcp|vcruntime|libomp)' })
if ($forbiddenDependencies.Count -gt 0) {
    throw "The engine still requires redistributable DLLs: $($forbiddenDependencies -join ', ')"
}

# Run from a separate directory with only the EXE; the old packaged DLL folder
# is never copied here or added to PATH.
$probe = Join-Path $WorkDirectory 'probe'
New-Item -ItemType Directory -Path $probe | Out-Null
$probeEngine = Join-Path $probe 'whisper-cli.exe'
Copy-Item -LiteralPath $engine -Destination $probeEngine
Push-Location $probe
try {
    $helpOutput = (Invoke-CheckedNative $probeEngine @('--help') | Out-String)
} finally { Pop-Location }
$helpOutput | Set-Content -LiteralPath (Join-Path $WorkDirectory 'help.log') -Encoding utf8
if ($helpOutput -notmatch '(?i)usage|options') { throw 'The engine did not return the expected help output.' }

$compilerFiles = @(Get-ChildItem -LiteralPath (Join-Path $build 'CMakeFiles') -Filter 'CMakeCXXCompiler.cmake' -Recurse -File)
if ($compilerFiles.Count -ne 1) { throw 'Could not identify the CMake compiler record.' }
$compilerRecord = Get-Content -LiteralPath $compilerFiles[0].FullName -Raw
$compilerVersion = [regex]::Match($compilerRecord, 'set\(CMAKE_CXX_COMPILER_VERSION "([^"]+)"\)').Groups[1].Value
$compilerId = [regex]::Match($compilerRecord, 'set\(CMAKE_CXX_COMPILER_ID "([^"]+)"\)').Groups[1].Value
if ($compilerId -ne 'MSVC' -or -not $compilerVersion) { throw 'The build was not produced by the expected MSVC compiler.' }
$engineSha256 = (Get-FileHash -LiteralPath $engine -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = [ordered]@{
    schema = 1
    version = $version
    source = $archiveUrl
    archiveSha256 = $archiveSha256
    builtAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    target = 'x86_64-pc-windows-msvc'
    variant = $Variant
    cpuRequirements = $cpuRequirements
    buildTarget = 'whisper-cli'
    generator = 'Visual Studio 17 2022'
    compiler = "$compilerId $compilerVersion"
    cmake = ((Invoke-CheckedNative $cmake @('--version') | Select-Object -First 1) | Out-String).Trim()
    path = $binaryRelativePath
    sha256 = $engineSha256
    options = $options
    dependencies = $dependencies
}

# Preserve the existing engine until download, compilation and checks succeed.
$destination = Join-Path $repositoryRoot $binaryRelativePath
$manifestDestination = Join-Path $repositoryRoot $manifestRelativePath
New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path $manifestDestination -Parent) -Force | Out-Null
$suffix = '.pending-' + [guid]::NewGuid().ToString('N')
$stagedEngine = $destination + $suffix
$stagedManifest = $manifestDestination + $suffix
try {
    Copy-Item -LiteralPath $engine -Destination $stagedEngine
    [System.IO.File]::WriteAllText($stagedManifest, (($manifest | ConvertTo-Json -Depth 8) + "`n"), [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::Move($stagedEngine, $destination, $true)
    [System.IO.File]::Move($stagedManifest, $manifestDestination, $true)
} finally {
    foreach ($file in @($stagedEngine, $stagedManifest)) {
        if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
    }
}
Write-Host "Built $binaryRelativePath"
Write-Host "SHA-256: $engineSha256"
Write-Host "Imports: $($dependencies -join ', ')"
