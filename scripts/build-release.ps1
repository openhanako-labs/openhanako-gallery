<#
  scripts/build-release.ps1 — 打三个发布包（nano / slim / full）。

  为什么是三个：功能代码完全一致，只差自带的依赖 —— 按你能接受的体积取舍。
    nano  不带 node_modules      体积最小，EXIF 与缩略图降级
    slim  带 exifr                EXIF 可用（拍摄时间 / 相机型号），缩略图关闭
    full  带 exifr + sharp 全树   EXIF 可用，缩略图可用

  依赖从「沙盒树」挑，不入库（见 .gitignore）：
    slim 从 <app>/node_modules 取 exifr
    full 从 <HANA_HOME>/app-data/hanako-gallery/node_modules 取整棵树

  用法：
    pwsh -File scripts/build-release.ps1
  产物在 out/，并打印每个包的体积与 sha256（发 Release 时贴进说明）。
#>
[CmdletBinding()]
param(
  # 打完顺带解压 nano 包做一次结构与语法自检
  [switch]$Verify = $true
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot          # 仓库根
$hanaHome = Split-Path -Parent (Split-Path -Parent $root)   # ...\.hanako
$out = Join-Path $root 'out'

# ── 版本：manifest 与 package 必须一致，否则发出去的包和标签对不上 ──
$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
if ($manifest.version -ne $pkg.version) {
  throw "版本不一致：manifest.json=$($manifest.version) package.json=$($pkg.version)"
}
$version = $manifest.version
Write-Host "版本 $version → $out" -ForegroundColor Cyan

# ── 包内容白名单：只发应用，不发仓库 ──
# 排除的：.git / scripts（开发门禁）/ 设计文档 / CONTRIBUTING / SECURITY / package-lock
$dirs  = 'assets', 'http', 'lib', 'runtime', 'sdk', 'skills', 'ui'
$files = 'index.js', 'manifest.json', 'package.json', 'README.md', 'LICENSE', 'COMMERCIAL-LICENSE.md'

$fullDeps = Join-Path $hanaHome 'app-data/hanako-gallery/node_modules'
$appDeps  = Join-Path $root 'node_modules'

function Copy-Tree($src, $dst) {
  if (-not (Test-Path $src)) { throw "缺少源：$src" }
  Copy-Item -Path $src -Destination $dst -Recurse -Force
}

function New-Variant {
  param([string]$Name, [string]$Deps)
  $stage = Join-Path $out "stage-$Name"
  if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $stage | Out-Null

  foreach ($d in $dirs)  { Copy-Tree (Join-Path $root $d) $stage }
  foreach ($f in $files) { Copy-Item -LiteralPath (Join-Path $root $f) -Destination $stage -Force }

  if ($Deps) {
    $nm = Join-Path $stage 'node_modules'
    New-Item -ItemType Directory -Force -Path $nm | Out-Null
    Copy-Tree $Deps $nm
  }

  $zip = Join-Path $out $Name
  if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }
  [System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, 'Optimal', $false)
  Remove-Item -LiteralPath $stage -Recurse -Force
  return $zip
}

# slim：只挑 exifr（从沙盒树优先，退回应用目录）
$exifr = if (Test-Path (Join-Path $appDeps 'exifr')) { Join-Path $appDeps 'exifr' }
         elseif (Test-Path (Join-Path $fullDeps 'exifr')) { Join-Path $fullDeps 'exifr' }
         else { $null }
if (-not $exifr) { throw '找不到 exifr，无法打 slim 包' }

$built = @()
$built += New-Variant -Name 'hanako-gallery-nano.zip' -Deps $null
$built += New-Variant -Name 'hanako-gallery.zip'      -Deps $exifr
$built += New-Variant -Name 'hanako-gallery-full.zip' -Deps $fullDeps

# ── 自检：包必须能解、结构必须对、JS 必须能 parse ──
if ($Verify) {
  $verifyDir = Join-Path $out '_verify'
  if (Test-Path $verifyDir) { Remove-Item -LiteralPath $verifyDir -Recurse -Force }
  foreach ($z in $built) {
    $name = [System.IO.Path]::GetFileNameWithoutExtension($z)
    $to = Join-Path $verifyDir $name
    [System.IO.Compression.ZipFile]::ExtractToDirectory($z, $to)

    # 入口文件必须在根（不能多包一层目录），且不能混进仓库私有内容
    foreach ($need in 'manifest.json', 'index.js', 'runtime/service.mjs') {
      if (-not (Test-Path (Join-Path $to $need))) { throw "$name 缺少 $need" }
    }
    foreach ($bad in '.git', 'scripts', '设计文档.md', 'package-lock.json') {
      if (Test-Path (Join-Path $to $bad)) { throw "$name 不该包含 $bad" }
    }
    # 路径分隔符必须是 /，否则在非 Windows 上解压会炸
    $arc = [System.IO.Compression.ZipFile]::OpenRead($z)
    $badSep = $arc.Entries | Where-Object { $_.FullName -match '\\' } | Select-Object -First 1
    $arc.Dispose()
    if ($badSep) { throw "$name 条目名含反斜杠：$($badSep.FullName)" }

    $js = Get-ChildItem -Path $to -Recurse -Include *.js, *.mjs |
      Where-Object { $_.FullName -notmatch '\\node_modules\\' }
    foreach ($f in $js) {
      node --check $f.FullName 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "$name 里 $($f.Name) 语法不过" }
    }
    $m = Get-Content (Join-Path $to 'manifest.json') -Raw | ConvertFrom-Json
    if ($m.version -ne $version) { throw "$name 里的 manifest 版本是 $($m.version)，应为 $version" }
    Write-Host "  ✓ $name 结构与语法自检通过（$($js.Count) 个 JS 文件）" -ForegroundColor Green
  }
  Remove-Item -LiteralPath $verifyDir -Recurse -Force
}

# ── 结果表 ──
Write-Host "`n| 资产 | 体积 | sha256 |" -ForegroundColor Cyan
Write-Host "|---|---|---|"
foreach ($z in $built) {
  $len = (Get-Item -LiteralPath $z).Length
  $hash = (Get-FileHash -LiteralPath $z -Algorithm SHA256).Hash.Substring(0, 16)
  $size = if ($len -ge 1MB) { '{0:N2} MB' -f ($len / 1MB) } else { '{0:N0} KB' -f ($len / 1KB) }
  Write-Host ('| `{0}` | {1} | `{2}` |' -f (Split-Path $z -Leaf), $size, $hash)
}
Write-Host "`n产物在 $out" -ForegroundColor Cyan
