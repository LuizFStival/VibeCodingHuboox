# Servidor local para Windows sem instalar nada (usa o PowerShell que já vem no Windows).
# Serve a pasta public/ em http://localhost:3334 e abre o navegador. Feche a janela para parar.
$ErrorActionPreference = 'Stop'
$sep = [IO.Path]::DirectorySeparatorChar
$root = (Resolve-Path (Join-Path (Join-Path $PSScriptRoot '..') 'public')).Path.TrimEnd($sep) + $sep
$port = 3334
$url = "http://localhost:$port/"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($url)
try {
  $listener.Start()
} catch {
  Write-Host "Nao foi possivel abrir a porta $port. O app ja esta aberto em outra janela? Erro: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json'; '.svg' = 'image/svg+xml'; '.png' = 'image/png'
}

Write-Host ''
Write-Host "  Carteira IA rodando em $url" -ForegroundColor Green
Write-Host '  Deixe esta janela aberta enquanto usa o app. Feche-a para parar.'
Write-Host ''
try { Start-Process $url } catch { Write-Host "  Abra $url no navegador." }

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $res = $ctx.Response
  try {
    $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
    if ($path -eq '/') { $path = '/index.html' }
    $file = [IO.Path]::GetFullPath((Join-Path $root $path.TrimStart('/').Replace('/', $sep)))
    if (-not $file.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) {
      $res.StatusCode = 404
    } else {
      $bytes = [IO.File]::ReadAllBytes($file)
      $ext = [IO.Path]::GetExtension($file).ToLower()
      if ($mime.ContainsKey($ext)) { $res.ContentType = $mime[$ext] } else { $res.ContentType = 'application/octet-stream' }
      $res.Headers.Add('X-Content-Type-Options', 'nosniff')
      $res.Headers.Add('Cache-Control', 'no-cache')
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    }
  } catch {
    $res.StatusCode = 500
  } finally {
    $res.Close()
  }
}
