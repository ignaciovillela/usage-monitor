# Instala Usage Monitor en Windows (x64) desde el último release de GitHub.
#
# Uso (PowerShell):
#   irm https://raw.githubusercontent.com/ignaciovillela/usage-monitor/main/scripts/install-win.ps1 | iex
# Con actualización automática (opcional):
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/ignaciovillela/usage-monitor/main/scripts/install-win.ps1))) -AutoUpdate
#
# Qué hace (léelo antes de ejecutarlo, es corto):
#   1. busca en GitHub el .zip de Windows del release más reciente;
#   2. si ya tienes esa versión, no hace nada; si no, lo descarga a una carpeta temporal;
#   3. cierra la copia instalada si está abierta, la reemplaza en %LOCALAPPDATA%\Programs\Usage Monitor
#      y crea un acceso directo en el menú Inicio;
#   4. abre la app (o la vuelve a abrir si estaba abierta).
# No usa permisos de administrador. Lo que baja PowerShell no lleva la marca «descargado de internet»,
# así que SmartScreen no avisa. Tus datos (%APPDATA%\Usage Monitor) no se tocan.
#
# Opciones:
#   -AutoUpdate         además crea una tarea programada que repite esto al iniciar sesión y cada día.
#   -DisableAutoUpdate  borra esa tarea y termina.
#   -Uninstall          borra la app, el acceso directo y la tarea (no tus datos) y termina.
#   -InstallDir <ruta>  otra carpeta de instalación.
#   -NoStart            no abrir la app al terminar.
#   -Quiet              sin mensajes (lo usa la tarea programada).
# También se puede activar con $env:USAGE_MONITOR_AUTOUPDATE = "1" antes de "irm ... | iex".
[CmdletBinding()]
param(
  [switch]$AutoUpdate,
  [switch]$DisableAutoUpdate,
  [switch]$Uninstall,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\Usage Monitor'),
  [switch]$NoStart,
  [switch]$Quiet
)
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

Say 'Buscando la última versión…'
$releases = Invoke-RestMethod -UseBasicParsing -Headers @{ 'User-Agent' = 'usage-monitor-installer' } `
  "https://api.github.com/repos/$Repo/releases?per_page=10"
$release = $releases | Where-Object { -not $_.draft -and ($_.assets | Where-Object name -like '*windows-x64.zip') } | Select-Object -First 1
if (-not $release) { throw "No encontré un instalador de Windows en https://github.com/$Repo/releases" }
$asset = $release.assets | Where-Object name -like '*windows-x64.zip' | Select-Object -First 1
$tag = $release.tag_name

$installed = if ((Test-Path $VerFile) -and (Test-Path $Exe)) { (Get-Content $VerFile -Raw).Trim() } else { '' }
if ($installed -eq $tag) {
  Say "Ya tienes la última versión ($tag)."
} else {
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("usage-monitor-" + [guid]::NewGuid())
  New-Item -ItemType Directory $tmp | Out-Null
  try {
    Say "Descargando $($asset.name)…"
    $zip = Join-Path $tmp 'app.zip'
    Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $zip
    Expand-Archive $zip (Join-Path $tmp 'x')
    $newExe = Get-ChildItem (Join-Path $tmp 'x') -Recurse -Filter 'Usage Monitor.exe' | Select-Object -First 1
    if (-not $newExe) { throw 'El zip no contiene Usage Monitor.exe.' }

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
  Start-Process $Exe -WorkingDirectory $InstallDir
  Say 'Abriendo Usage Monitor… el ícono aparece en la bandeja, junto al reloj (puede quedar bajo «^»).'
}
