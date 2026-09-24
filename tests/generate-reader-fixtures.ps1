param([string]$OutputDir = (Join-Path $PSScriptRoot 'tmp/reader-fixtures'))

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$epubPath = Join-Path $OutputDir 'ja-vertical.epub'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$stream = [System.IO.File]::Create($epubPath)
$zip = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create)

function Add-EpubEntry([string]$name, [string]$content, [System.IO.Compression.CompressionLevel]$compression) {
    $entry = $zip.CreateEntry($name, $compression)
    $writer = [System.IO.StreamWriter]::new($entry.Open(), $utf8)
    try { $writer.Write($content) } finally { $writer.Dispose() }
}

try {
    Add-EpubEntry 'mimetype' 'application/epub+zip' ([System.IO.Compression.CompressionLevel]::NoCompression)
    Add-EpubEntry 'META-INF/container.xml' @'
<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
'@ ([System.IO.Compression.CompressionLevel]::Optimal)
    Add-EpubEntry 'OEBPS/content.opf' @'
<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" unique-identifier="id" xml:lang="ja" xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">urn:uuid:baef9664-c198-471e-af84-73659da53d74</dc:identifier>
    <dc:title>日本語縦書き検証</dc:title><dc:language>ja</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
    <item id="style" href="style.css" media-type="text/css"/>
  </manifest>
  <spine page-progression-direction="rtl"><itemref idref="chapter"/></spine>
</package>
'@ ([System.IO.Compression.CompressionLevel]::Optimal)
    Add-EpubEntry 'OEBPS/nav.xhtml' @'
<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ja">
<head><title>目次</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">第一章</a></li></ol></nav></body></html>
'@ ([System.IO.Compression.CompressionLevel]::Optimal)
    Add-EpubEntry 'OEBPS/chapter.xhtml' @'
<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja">
<head><title>第一章</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><section><h1>第一章　雨の街</h1>
<p>「<ruby>図書館<rt>としょかん</rt></ruby>へ行こう」と、彼女は静かに言った。</p>
<p>雨が降る。風が止む。ABCと<span class="tcy">12</span>が並ぶ。<em>大切な言葉</em>を忘れない。</p>
<p>括弧「」と句読点、。の配置、長音符ー、禁則処理を確認する。</p>
<img src="https://example.invalid/epub-resource.png" alt="外部画像"/>
</section></body></html>
'@ ([System.IO.Compression.CompressionLevel]::Optimal)
    Add-EpubEntry 'OEBPS/style.css' @'
@charset "UTF-8";
html, body { writing-mode: vertical-rl; }
body { font-family: "Yu Mincho", "Noto Serif CJK JP", serif; line-height: 1.9; }
rt { font-size: 0.5em; }
.tcy { text-combine-upright: all; }
'@ ([System.IO.Compression.CompressionLevel]::Optimal)
} finally {
    $zip.Dispose()
    $stream.Dispose()
}

Write-Output $epubPath
