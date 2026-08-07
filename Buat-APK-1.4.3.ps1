$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$androidRoot = Join-Path $projectRoot 'apps\android-cashier'
$keystore = 'C:\Users\Asus\Documents\Kasir-Nusa-Private\kasir-nusa-release.jks'
$builtApk = Join-Path $androidRoot 'app\build\outputs\apk\release\app-release.apk'
$releaseApk = Join-Path $projectRoot 'releases\Kasir-Nusa-POS-1.4.3.apk'
$publicApk = Join-Path $projectRoot 'apps\web\downloads\Kasir-Nusa-POS-1.4.3.apk'

if (-not (Test-Path -LiteralPath $keystore)) {
    throw "Kunci permanen tidak ditemukan: $keystore"
}

if (-not (Test-Path -LiteralPath (Join-Path $androidRoot 'app\google-services.json'))) {
    throw 'Konfigurasi Firebase Android belum terpasang.'
}

function Read-PlainSecret([string]$prompt) {
    $secure = Read-Host $prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

$storePassword = Read-PlainSecret 'Masukkan password keystore'
$keyPassword = Read-PlainSecret 'Masukkan password key (biasanya sama)'
$keytool = Join-Path $env:JAVA_HOME 'bin\keytool.exe'
$aliasOutput = & $keytool -list -v -keystore $keystore -storepass $storePassword 2>&1
if ($LASTEXITCODE -ne 0) { throw 'Password keystore tidak benar.' }
$aliasMatch = [regex]::Match(($aliasOutput -join "`n"), '(?im)^(?:Alias name|Nama alias):\s*(.+)$')
if (-not $aliasMatch.Success) { throw 'Alias key tidak dapat dibaca otomatis.' }
$keyAlias = $aliasMatch.Groups[1].Value.Trim()
Write-Host "Alias ditemukan: $keyAlias" -ForegroundColor Cyan

try {
    $env:KASIR_NUSA_KEYSTORE_FILE = $keystore
    $env:KASIR_NUSA_KEYSTORE_PASSWORD = $storePassword
    $env:KASIR_NUSA_KEY_ALIAS = $keyAlias
    $env:KASIR_NUSA_KEY_PASSWORD = $keyPassword
    Push-Location $androidRoot
    try { & .\gradlew.bat clean assembleRelease }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $builtApk)) {
        throw 'Build APK gagal. Periksa password dan alias key.'
    }
    Copy-Item -LiteralPath $builtApk -Destination $releaseApk -Force
    Copy-Item -LiteralPath $builtApk -Destination $publicApk -Force
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $builtApk).Hash
    Write-Host ''
    Write-Host 'APK 1.4.3 dengan perbaikan scanner HID berhasil dibuat.' -ForegroundColor Green
    Write-Host "SHA-256: $hash"
    Write-Host 'Kembali ke Codex dan ketik: APK 1.4.3 BERHASIL'
} finally {
    $storePassword = $null
    $keyPassword = $null
    Remove-Item Env:KASIR_NUSA_KEYSTORE_FILE,Env:KASIR_NUSA_KEYSTORE_PASSWORD,Env:KASIR_NUSA_KEY_ALIAS,Env:KASIR_NUSA_KEY_PASSWORD -ErrorAction SilentlyContinue
}
