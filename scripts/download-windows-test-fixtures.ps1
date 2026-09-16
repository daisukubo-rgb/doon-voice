$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$destination = Join-Path $env:RUNNER_TEMP 'doon-voice-test-fixtures'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$fixtures = @(
    @{
        Name = 'ggml-large-v3-turbo-q5_0.bin'
        Url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin'
        Sha256 = '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'
        Environment = 'DOON_TEST_MODEL'
    },
    @{
        Name = 'jfk.wav'
        Url = 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/v1.9.2/samples/jfk.wav'
        Sha256 = '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e'
        Environment = 'DOON_TEST_AUDIO'
    }
)
foreach ($fixture in $fixtures) {
    $target = Join-Path $destination $fixture.Name
    Invoke-WebRequest -Uri $fixture.Url -OutFile $target
    if ((Get-FileHash $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $fixture.Sha256) {
        throw "Test fixture checksum differs: $($fixture.Name)"
    }
    "$($fixture.Environment)=$target" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
}
