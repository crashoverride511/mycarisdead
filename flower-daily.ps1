# flower-daily.ps1 — scheduled daily FLOWER refresh (local, full incl. JARS).
# 1) runs the data pipeline (run-flower-daily.js) 2) republishes the artifact.
# Registered under Task Scheduler as "TucsonFlowerDaily" (run only when logged on,
# so JARS's headed Chrome has an interactive desktop). Logs to flower-daily.log.

$ErrorActionPreference = 'Continue'
$dir  = 'C:\Users\konst\Claude\Code'
Set-Location $dir
$log  = Join-Path $dir 'flower-daily.log'
$node   = 'C:\Program Files\nodejs\node.exe'
$claude = "$env:USERPROFILE\.local\bin\claude.exe"
$url    = 'https://claude.ai/code/artifact/ec698d8e-25c9-400d-89e1-cbe01a1275ba'

"`n===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') run start (SKIP_JARS=$($env:SKIP_JARS)) =====" | Out-File -FilePath $log -Append -Encoding utf8

# 1) data pipeline -> tucson-flower.html
& $node run-flower-daily.js *>> $log 2>&1

# 2) republish the same artifact URL (Artifact tool lives in Claude Code)
$prompt = "Publish the file tucson-flower.html (in this directory) to the existing artifact at $url, keeping the same URL. Use the Artifact tool with the url parameter set to that address and favicon set to the herb emoji. Publish only — do not edit files, do not run the pipeline, do not touch any pre-roll artifact."
& $claude -p $prompt --dangerously-skip-permissions *>> $log 2>&1

# 3) desktop alert if a NEW better-than-$88/oz deal was found
try {
  $a = Get-Content (Join-Path $dir 'flower-alert.json') -Raw | ConvertFrom-Json
  if ($a.isNew) {
    $title = "Tucson Flower: deal under `$$($a.threshold)/oz"
    $body  = "`$$($a.oz)/oz · $($a.thc)% · $($a.name) @ $($a.dispensary)"
    "ALERT fired: $body" | Out-File -FilePath $log -Append -Encoding utf8
    # Prefer a native toast; fall back to a tray balloon that needs no install.
    try {
      $tmpl = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
      $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
      $t = $xml.GetElementsByTagName('text'); $t.Item(0).AppendChild($xml.CreateTextNode($title)) | Out-Null; $t.Item(1).AppendChild($xml.CreateTextNode($body)) | Out-Null
      $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
      [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Tucson Flower').Show($toast)
    } catch {
      Add-Type -AssemblyName System.Windows.Forms
      $ni = New-Object System.Windows.Forms.NotifyIcon
      $ni.Icon = [System.Drawing.SystemIcons]::Information; $ni.Visible = $true
      $ni.BalloonTipTitle = $title; $ni.BalloonTipText = $body; $ni.ShowBalloonTip(15000)
      Start-Sleep -Seconds 16; $ni.Dispose()
    }
  }
} catch { "alert step error: $_" | Out-File -FilePath $log -Append -Encoding utf8 }

"===== done $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') =====" | Out-File -FilePath $log -Append -Encoding utf8
