# Instala Usage Monitor en Windows (x64) desde el último release de GitHub.
#
# Uso (PowerShell):
#   irm https://raw.githubusercontent.com/ignaciovillela/usage-monitor/main/scripts/install-win.ps1 | iex
# Con actualización automática (opcional):
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/ignaciovillela/usage-monitor/main/scripts/install-win.ps1))) -AutoUpdate
#
# Qué hace (léelo antes de ejecutarlo, es corto):
#   1. busca en GitHub el .zip de Windows de la última versión del canal (main: estables; dev: también las -dev.N);
#   2. si ya tienes esa versión, no hace nada; si no, lo descarga a una carpeta temporal;
#   3. cierra la copia instalada si está abierta, la reemplaza en %LOCALAPPDATA%\Programs\Usage Monitor
#      y crea un acceso directo en el menú Inicio;
#   4. abre la app (o la vuelve a abrir si estaba abierta).
# No usa permisos de administrador. Lo que baja PowerShell no lleva la marca «descargado de internet»,
# así que SmartScreen no avisa. Tus datos (%APPDATA%\Usage Monitor) no se tocan.
#
# Opciones:
#   -Channel main|dev   canal de versiones. Sin indicarlo: el que elegiste en la app (Ajustes → Canal de
#                       actualizaciones); si nunca elegiste, el de la versión instalada; en una instalación nueva, main.
#   -AutoUpdate         además crea una tarea programada que repite esto al iniciar sesión y cada día
#                       (sigue el canal elegido en la app).
#   -DisableAutoUpdate  borra esa tarea y termina.
#   -Uninstall          borra la app, el acceso directo y la tarea (no tus datos) y termina.
#   -InstallDir <ruta>  otra carpeta de instalación.
#   -NoStart            no abrir la app al terminar.
#   -Quiet              sin mensajes (lo usa la tarea programada).
# Los usa la app al pulsar «Actualizar ahora» (ella descarga el zip con barra de progreso y comprueba su sha256):
#   -ZipPath <zip> -Tag <vX.Y.Z>  instalar ese zip en vez de buscar y descargar.
#   -WaitPid <pid>      esperar a que la app se cierre antes de reemplazarla, y volver a abrirla después.
#   -Relaunch <exe>     si algo falla, abrir este .exe (la versión que se estaba usando).
#   -ErrorLog <archivo> si algo falla, dejar ahí el error (la app lo muestra al volver a abrirse).
# También se puede activar con $env:USAGE_MONITOR_AUTOUPDATE = "1" antes de "irm ... | iex".
[CmdletBinding()]
param(
  [switch]$AutoUpdate,
  [switch]$DisableAutoUpdate,
  [switch]$Uninstall,
  [ValidateSet('', 'main', 'dev')][string]$Channel = '',
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\Usage Monitor'),
  [switch]$NoStart,
  [switch]$Quiet,
  [string]$ZipPath = '',
  [string]$Tag = '',
  [int]$WaitPid = 0,
  [string]$Relaunch = '',
  [string]$ErrorLog = ''
)
# Con -ErrorLog (lo pasa la app): cualquier error se guarda ahí y se vuelve a abrir la versión que estaba en uso.
trap {
  if (-not $ErrorLog) { break }
  try { Set-Content -LiteralPath $ErrorLog -Value "$_" -Encoding UTF8 } catch { }
  if ($Relaunch -and (Test-Path -LiteralPath $Relaunch)) { Start-Process -FilePath $Relaunch }
  exit 1
}
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # en PowerShell 5.1 la barra de progreso hace lentísima la descarga
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo      = 'ignaciovillela/usage-monitor'
$ScriptUrl = "https://raw.githubusercontent.com/$Repo/main/scripts/install-win.ps1"
$TaskName  = 'Usage Monitor - actualizar'
$Exe       = Join-Path $InstallDir 'Usage Monitor.exe'
$VerFile   = Join-Path $InstallDir '.release-tag'
$Updater   = Join-Path $env:LOCALAPPDATA 'Usage Monitor Updater\install-win.ps1'
$Shortcut  = Join-Path ([Environment]::GetFolderPath('Programs')) 'Usage Monitor.lnk'
if ($env:USAGE_MONITOR_AUTOUPDATE -eq '1') { $AutoUpdate = $true }
if ($Quiet) { $NoStart = $true }   # la tarea programada solo reabre la app si la cerró para actualizar
if ($WaitPid) { $NoStart = $false }   # la app se cerró para actualizarse: se vuelve a abrir

function Say($m) { if (-not $Quiet) { Write-Host $m } }

function Remove-UpdateTask {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Say 'Actualización automática desactivada.'
  }
  Remove-Item (Split-Path $Updater) -Recurse -Force -ErrorAction SilentlyContinue
}

function Stop-App {
  $running = Get-Process -Name 'Usage Monitor' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase) }
  if ($running) {
    Say 'Cerrando la versión instalada, que está abierta…'
    $running | Stop-Process -Force
    Start-Sleep -Seconds 2
  }
  return [bool]$running
}

if ($DisableAutoUpdate) { Remove-UpdateTask; return }
if ($Uninstall) {
  [void](Stop-App)
  Remove-UpdateTask
  Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $Shortcut -Force -ErrorAction SilentlyContinue
  Say "Desinstalado. Tus datos siguen en $env:APPDATA\Usage Monitor (bórralos a mano si quieres)."
  return
}

if (-not [Environment]::Is64BitOperatingSystem) { throw 'Los instaladores publicados son para Windows x64.' }

$installed = if ((Test-Path $VerFile) -and (Test-Path $Exe)) { (Get-Content $VerFile -Raw).Trim() } else { '' }

# Orden por versión (no por fecha): vX.Y.Z-dev.N va antes que vX.Y.Z. Otras etiquetas se ignoran.
function Get-VersionKey($tag) {
  if ($tag -notmatch '^v?(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?$') { return $null }
  $build = if ($Matches[4]) { [int]$Matches[4] } else { [int]::MaxValue }
  return '{0:D6}.{1:D6}.{2:D6}.{3:D10}' -f [int]$Matches[1], [int]$Matches[2], [int]$Matches[3], $build
}

if ($ZipPath) {
  # Zip ya descargado (y verificado) por la app.
  if (-not (Test-Path -LiteralPath $ZipPath)) { throw "No existe el archivo de la actualización: $ZipPath" }
  if (-not (Get-VersionKey $Tag)) { throw "Versión no válida: '$Tag'" }
  $tag = $Tag
  $assetName = Split-Path $ZipPath -Leaf
} else {
# Canal: el parámetro; si no, el elegido en la app; si no, el de la versión instalada; si no, main.
if (-not $Channel) {
  try {
    $appSettings = Get-Content (Join-Path $env:APPDATA 'Usage Monitor\settings.json') -Raw -ErrorAction Stop | ConvertFrom-Json
    if ($appSettings.updateChannel -in 'main', 'dev') { $Channel = $appSettings.updateChannel }
  } catch { }
}
if (-not $Channel) { $Channel = if ($installed -match '-dev\.') { 'dev' } else { 'main' } }

Say "Buscando la última versión (canal $Channel)…"
$releases = Invoke-RestMethod -UseBasicParsing -Headers @{ 'User-Agent' = 'usage-monitor-installer' } `
  "https://api.github.com/repos/$Repo/releases?per_page=40"
$release = $releases |
  Where-Object { -not $_.draft -and (Get-VersionKey $_.tag_name) -and ($Channel -eq 'dev' -or $_.tag_name -notmatch '-dev\.') } |
  Where-Object { $_.assets | Where-Object name -like '*windows-x64.zip' } |
  Sort-Object { Get-VersionKey $_.tag_name } -Descending | Select-Object -First 1
if (-not $release) { throw "No encontré un instalador de Windows del canal $Channel en https://github.com/$Repo/releases" }
$asset = $release.assets | Where-Object name -like '*windows-x64.zip' | Select-Object -First 1
$tag = $release.tag_name
$assetName = $asset.name
}

if ($installed -eq $tag) {
  Say "Ya tienes la última versión ($tag)."
  if ($ZipPath) { Remove-Item -LiteralPath $ZipPath -Force -ErrorAction SilentlyContinue }
} else {
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("usage-monitor-" + [guid]::NewGuid())
  New-Item -ItemType Directory $tmp | Out-Null
  try {
    if ($ZipPath) {
      $zip = $ZipPath
    } else {
      Say "Descargando $assetName…"
      $zip = Join-Path $tmp 'app.zip'
      Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $zip
    }
    Expand-Archive -LiteralPath $zip (Join-Path $tmp 'x')
    $newExe = Get-ChildItem (Join-Path $tmp 'x') -Recurse -Filter 'Usage Monitor.exe' | Select-Object -First 1
    if (-not $newExe) { throw 'El zip no contiene Usage Monitor.exe.' }

    if ($WaitPid) { Wait-Process -Id $WaitPid -Timeout 60 -ErrorAction SilentlyContinue }   # la app se está cerrando
    $wasRunning = Stop-App
    $old = "$InstallDir.old"
    Remove-Item $old -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $InstallDir) { Rename-Item $InstallDir (Split-Path $old -Leaf) }
    New-Item -ItemType Directory -Force (Split-Path $InstallDir) | Out-Null
    try {
      Move-Item $newExe.DirectoryName $InstallDir
    } catch {
      if (Test-Path $old) { Rename-Item $old (Split-Path $InstallDir -Leaf) }   # deja la versión anterior
      throw
    }
    Remove-Item $old -Recurse -Force -ErrorAction SilentlyContinue
    Set-Content $VerFile $tag -Encoding ASCII
    Say "Instalado $tag en $InstallDir"
    if ($Quiet -and $wasRunning) { $NoStart = $false }
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    if ($ZipPath) { Remove-Item -LiteralPath $ZipPath -Force -ErrorAction SilentlyContinue }
  }
}

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($Shortcut)
$lnk.TargetPath = $Exe
$lnk.WorkingDirectory = $InstallDir
$lnk.Save()

if ($AutoUpdate) {
  # Guarda una copia local del instalador: la tarea ejecuta esa copia, no código bajado en cada pasada.
  New-Item -ItemType Directory -Force (Split-Path $Updater) | Out-Null
  if ($PSCommandPath -and ($PSCommandPath -ne $Updater)) { Copy-Item $PSCommandPath $Updater -Force }
  elseif (-not $PSCommandPath) { Invoke-WebRequest -UseBasicParsing $ScriptUrl -OutFile $Updater }
  $taskArgs = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Updater`" -Quiet -InstallDir `"$InstallDir`""
  $action   = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArgs
  $triggers = @(
    (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"),
    (New-ScheduledTaskTrigger -Daily -At '12:00')
  )
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RunOnlyIfNetworkAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings `
    -Description 'Actualiza Usage Monitor desde GitHub (creada por install-win.ps1).' -Force | Out-Null
  Say "Actualización automática activada (al iniciar sesión y cada día). Para quitarla: -DisableAutoUpdate"
}

if (-not $NoStart) {
  if ($WaitPid) { Wait-Process -Id $WaitPid -Timeout 60 -ErrorAction SilentlyContinue }   # una sola instancia a la vez
  Start-Process $Exe -WorkingDirectory $InstallDir
  Say 'Abriendo Usage Monitor… el ícono aparece en la bandeja, junto al reloj (puede quedar bajo «^»).'
}
