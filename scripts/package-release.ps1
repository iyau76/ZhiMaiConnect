[CmdletBinding()]
param(
    [string]$OutputDirectory = "",
    [string]$ArchiveBaseName = "",
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $repoRoot "release"
}
if ([string]::IsNullOrWhiteSpace($ArchiveBaseName)) {
    $ArchiveBaseName = "ZhimaiConnect-project-package-$(Get-Date -Format 'yyyyMMdd')"
}

$outputFull = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($outputFull) | Out-Null
$archivePath = Join-Path $outputFull "$ArchiveBaseName.zip"
$sidecarPath = Join-Path $outputFull "$ArchiveBaseName.manifest.json"

foreach ($target in @($archivePath, $sidecarPath)) {
    if (Test-Path -LiteralPath $target) {
        if (-not $Force) { throw "Output already exists: $target (use -Force to replace it)" }
        Remove-Item -LiteralPath $target -Force
    }
}

$finalVideoRelative = "videos/zhimai-connect-promo/renders/zhimai-connect-final-kobe-direct.mp4"
$finalVideoPath = Join-Path $repoRoot ($finalVideoRelative.Replace('/', [IO.Path]::DirectorySeparatorChar))
$expectedVideoSha256 = "6FC5689BA79525ADBF9E290964ED3D3DBCBC9920DD8CA7BC6893C8AF21B98A64"
if (-not (Test-Path -LiteralPath $finalVideoPath -PathType Leaf)) { throw "Final video is missing: $finalVideoRelative" }
$videoSha256 = (Get-FileHash -LiteralPath $finalVideoPath -Algorithm SHA256).Hash
if ($videoSha256 -ne $expectedVideoSha256) { throw "Final video hash changed: $videoSha256" }

$deniedSegments = @(
    ".git", "node_modules", ".output", ".tanstack", ".wrangler", ".vinxi", ".nitro",
    "dist", "build", "coverage", "playwright-report", "test-results", "__pycache__",
    ".cache", ".parcel-cache", ".vite", ".turbo", "release"
)
$deniedLeafPatterns = @("*.log", "*.tmp", "*.bak", "*.pyc", "*.pyo", "*.pem", "*.key", "*.p12", "*.pfx", "Thumbs.db", ".DS_Store", "({target")
$filesByRelative = [Collections.Generic.Dictionary[string, IO.FileInfo]]::new([StringComparer]::OrdinalIgnoreCase)

function Get-RelativeSlashPath([string]$FullName) {
    $relative = $FullName.Substring($repoRoot.Length) -replace '^[\\/]+', ''
    return $relative.Replace('\', '/')
}

function Test-Denied([IO.FileInfo]$File, [string]$Relative) {
    $segments = $Relative.ToLowerInvariant().Split('/')
    foreach ($segment in $segments) {
        if ($deniedSegments -contains $segment) { return $true }
    }
    foreach ($pattern in $deniedLeafPatterns) {
        if ($File.Name -like $pattern) { return $true }
    }
    if ($File.Name -match '(?i)(api[_-]?config|credentials?|secrets?|cookies?|storage[_-]?state|auth[_-]?state)') { return $true }
    if ($File.Name -match '(?i)^\.env($|\.)' -and $File.Name -ne '.env.example') { return $true }
    return $false
}

function Add-Candidate([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    $file = Get-Item -LiteralPath $Path -Force
    $relative = Get-RelativeSlashPath $file.FullName
    if (-not (Test-Denied $file $relative)) { $filesByRelative[$relative] = $file }
}

function Add-Tree([string]$RelativeDirectory) {
    $directory = Join-Path $repoRoot ($RelativeDirectory.Replace('/', [IO.Path]::DirectorySeparatorChar))
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) { return }
    Get-ChildItem -LiteralPath $directory -Recurse -File -Force | ForEach-Object { Add-Candidate $_.FullName }
}

$rootFiles = @(
    ".env.example", ".gitignore", ".prettierignore", ".prettierrc", "AGENTS.md", "README.md",
    "bun.lock", "bunfig.toml", "components.json", "eslint.config.js", "package-lock.json", "package.json",
    "playwright.config.ts", "tsconfig.json", "video-spec.md", "vite.config.ts", "vitest.config.ts"
)
foreach ($relative in $rootFiles) { Add-Candidate (Join-Path $repoRoot $relative) }
foreach ($relative in @(".codex", ".lovable", "doc", "e2e", "public", "scripts", "src")) { Add-Tree $relative }

$videoRoot = Join-Path $repoRoot "videos/zhimai-connect-promo"
Get-ChildItem -LiteralPath $videoRoot -File -Force | ForEach-Object { Add-Candidate $_.FullName }
foreach ($relative in @(
    "videos/zhimai-connect-promo/compositions",
    "videos/zhimai-connect-promo/tools",
    "videos/zhimai-connect-promo/media/fonts",
    "videos/zhimai-connect-promo/media/images",
    "videos/zhimai-connect-promo/media/sfx"
)) { Add-Tree $relative }

$textExtensions = @(".json", ".md", ".txt", ".srt", ".csv", ".yaml", ".yml")
foreach ($relative in @(
    "videos/zhimai-connect-promo/.hyperframes",
    "videos/zhimai-connect-promo/media/audio",
    "videos/zhimai-connect-promo/media/capture"
)) {
    $directory = Join-Path $repoRoot ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
    Get-ChildItem -LiteralPath $directory -Recurse -File -Force -ErrorAction SilentlyContinue |
        Where-Object { $textExtensions -contains $_.Extension.ToLowerInvariant() } |
        ForEach-Object { Add-Candidate $_.FullName }
}
Add-Candidate $finalVideoPath

foreach ($item in $filesByRelative.GetEnumerator()) {
    if ($item.Key.StartsWith("videos/", [StringComparison]::OrdinalIgnoreCase) -and
        $item.Value.Length -ge 10MB -and
        $item.Key -ne $finalVideoRelative) {
        throw "Unexpected large video-project file selected: $($item.Key)"
    }
}

$ordered = $filesByRelative.GetEnumerator() | Sort-Object Key
[long]$uncompressedBytes = 0
foreach ($item in $ordered) { $uncompressedBytes += $item.Value.Length }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($archivePath, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($item in $ordered) {
        $entryName = "ZhimaiConnect/$($item.Key)"
        $level = if ($item.Key -eq $finalVideoRelative) { [IO.Compression.CompressionLevel]::NoCompression } else { [IO.Compression.CompressionLevel]::Optimal }
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $item.Value.FullName, $entryName, $level) | Out-Null
    }

    $manifestLines = @(
        "Zhimai Connect delivery package",
        "Created (UTC): $([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))",
        "Source: current working tree (including uncommitted work)",
        "Included files: $($ordered.Count)",
        "Uncompressed bytes: $uncompressedBytes",
        "Final video: $finalVideoRelative",
        "Final video SHA-256: $videoSha256",
        "",
        "Excluded: Git history, dependencies, build/test output, caches, browser captures, narration/BGM intermediates, previews, snapshots, old renders, secrets and local state.",
        "Install after extraction: npm ci",
        "Verify: npm run typecheck; npm run lint; npm run test:run; npm run build",
        "",
        "Included file inventory (bytes<TAB>path):"
    )
    foreach ($item in $ordered) { $manifestLines += "$($item.Value.Length)`t$($item.Key)" }
    $manifestEntry = $archive.CreateEntry("ZhimaiConnect/PACKAGE_MANIFEST.txt", [IO.Compression.CompressionLevel]::Optimal)
    $writer = [IO.StreamWriter]::new($manifestEntry.Open(), [Text.UTF8Encoding]::new($false))
    try { $writer.Write(($manifestLines -join "`n")) } finally { $writer.Dispose() }
}
finally {
    $archive.Dispose()
}

$archiveInfo = Get-Item -LiteralPath $archivePath
$archiveSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
$sidecar = [ordered]@{
    archive = $archiveInfo.Name
    archive_bytes = $archiveInfo.Length
    archive_sha256 = $archiveSha256
    package_root = "ZhimaiConnect/"
    included_files = $ordered.Count + 1
    source_uncompressed_bytes = $uncompressedBytes
    final_video = $finalVideoRelative
    final_video_sha256 = $videoSha256
    exclusion_policy = "No Git history, dependencies, build/test artifacts, caches, raw capture, audio/BGM intermediates, old renders, secrets, or local state."
}
$sidecar | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $sidecarPath -Encoding utf8
$sidecar | ConvertTo-Json -Compress
