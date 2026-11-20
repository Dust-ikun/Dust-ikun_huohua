<#
.SYNOPSIS
  抖音续火 · 本地每日定时执行 + 失败邮件通知。

.DESCRIPTION
  本脚本不改动项目业务代码（src/ 一行都不动），只在外层包一层：
  1) 强制无头模式运行 src/main.ts，控制台输出追加到 artifacts\logs\<日期>.log
  2) 退出码非 0 或超时 → 通过 QQ 邮箱 SMTP 发送告警邮件，并附上失败截图
  3) 结果同时写入 artifacts\LAST_RESULT.txt，方便快速判断最近一次状态
  4) 自动清理 30 天前的日志

  邮件参数从项目根目录的 .env 读取（.env 已被 .gitignore 忽略）：
    MAIL_ADDRESS   发件邮箱，例如 xxxx@qq.com
    MAIL_TO        收件邮箱，留空则发给 MAIL_ADDRESS
    MAIL_USERNAME  SMTP 登录账号，留空则用 MAIL_ADDRESS
    MAIL_PASSWORD  邮箱授权码（不是 QQ 密码）
    MAIL_HOST      默认 smtp.qq.com
    MAIL_PORT      默认 587（STARTTLS；不要用 465，.NET 的 SmtpClient 不支持隐式 SSL）

.PARAMETER TestMail
  只发一封测试邮件验证配置，不执行续火。

.PARAMETER SkipIfDone
  若当天日志里已有成功记录则直接跳过，供备用触发器避免重复发送。

.PARAMETER TimeoutMinutes
  单次执行超时分钟数，默认 30，超时会杀掉浏览器进程并按失败告警。

.PARAMETER KeepLogDays
  日志保留天数，默认 30；设为 0 表示不清理。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-daily.ps1 -TestMail
#>
[CmdletBinding()]
param(
  [switch]$TestMail,
  [switch]$SkipIfDone,
  [int]$TimeoutMinutes = 30,
  [int]$KeepLogDays = 30
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$artifactsDir = Join-Path $root 'artifacts'
$logDir = Join-Path $artifactsDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
New-Item -ItemType Directory -Force -Path $artifactsDir | Out-Null

$logFile = Join-Path $logDir ('{0}.log' -f (Get-Date -Format 'yyyy-MM-dd'))
$resultFile = Join-Path $artifactsDir 'LAST_RESULT.txt'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Log {
  param([string]$Message, [string]$Level = 'INFO')
  $line = '[{0}] [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
  [System.IO.File]::AppendAllText($logFile, $line + [Environment]::NewLine, $utf8NoBom)
  Write-Host $line
}

function Write-Result {
  param([string]$Text)
  [System.IO.File]::WriteAllText($resultFile, $Text + [Environment]::NewLine, $utf8NoBom)
}

# 读取 .env（只做简单的 KEY=VALUE 解析，不依赖 dotenv）
function Get-EnvMap {
  $map = @{}
  $envPath = Join-Path $root '.env'
  if (-not (Test-Path $envPath)) {
    return $map
  }

  foreach ($line in [System.IO.File]::ReadAllLines($envPath)) {
    $trimmed = $line.Trim().TrimStart([char]0xFEFF)
    if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }

    $index = $trimmed.IndexOf('=')
    if ($index -lt 1) { continue }

    $key = $trimmed.Substring(0, $index).Trim()
    $value = $trimmed.Substring($index + 1).Trim()

    if ($value.Length -ge 2) {
      $first = $value.Substring(0, 1)
      $last = $value.Substring($value.Length - 1, 1)
      if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }

    $map[$key] = $value
  }

  return $map
}

function Get-MailConfig {
  $envMap = Get-EnvMap

  $address = [string]$envMap['MAIL_ADDRESS']
  $config = [PSCustomObject]@{
    Address  = $address
    To       = $(if ($envMap['MAIL_TO']) { [string]$envMap['MAIL_TO'] } else { $address })
    Username = $(if ($envMap['MAIL_USERNAME']) { [string]$envMap['MAIL_USERNAME'] } else { $address })
    Password = [string]$envMap['MAIL_PASSWORD']
    Host     = $(if ($envMap['MAIL_HOST']) { [string]$envMap['MAIL_HOST'] } else { 'smtp.qq.com' })
    Port     = $(if ($envMap['MAIL_PORT']) { [int]$envMap['MAIL_PORT'] } else { 587 })
  }

  $config | Add-Member -MemberType NoteProperty -Name Ready -Value (
    $config.Address -ne '' -and $config.Username -ne '' -and $config.Password -ne ''
  )

  return $config
}

function Send-Mail {
  param(
    [Parameter(Mandatory = $true)][PSCustomObject]$Config,
    [Parameter(Mandatory = $true)][string]$Subject,
    [Parameter(Mandatory = $true)][string]$Body,
    [string[]]$Attachments = @()
  )

  $message = New-Object System.Net.Mail.MailMessage
  $client = New-Object System.Net.Mail.SmtpClient($Config.Host, $Config.Port)

  try {
    $client.EnableSsl = $true
    $client.Timeout = 30000
    $client.Credentials = New-Object System.Net.NetworkCredential($Config.Username, $Config.Password)

    $message.From = New-Object System.Net.Mail.MailAddress($Config.Address)
    [void]$message.To.Add($Config.To)
    $message.Subject = $Subject
    $message.SubjectEncoding = [System.Text.Encoding]::UTF8
    $message.Body = $Body
    $message.BodyEncoding = [System.Text.Encoding]::UTF8
    $message.IsBodyHtml = $false

    foreach ($path in $Attachments) {
      if (Test-Path $path) {
        $message.Attachments.Add((New-Object System.Net.Mail.Attachment($path)))
      }
    }

    $client.Send($message)
  } finally {
    $message.Dispose()
    $client.Dispose()
  }
}

# 把中文文件名复制成 ASCII 名，避免部分邮件客户端附件名乱码
function Copy-AttachmentsForMail {
  param([string[]]$Paths)

  if ($null -eq $Paths -or $Paths.Count -eq 0) {
    return @()
  }

  $tempDir = Join-Path $env:TEMP ('douyin-spark-mail-{0}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
  New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

  $copied = @()
  $index = 1
  foreach ($path in $Paths) {
    $target = Join-Path $tempDir ('failure-{0}.png' -f $index)
    Copy-Item -Path $path -Destination $target -Force
    $copied += $target
    $index++
  }

  return $copied
}

function Remove-ExpiredLogs {
  if ($KeepLogDays -le 0) { return }

  $deadline = (Get-Date).AddDays(-$KeepLogDays)
  Get-ChildItem -Path $logDir -Filter '*.log' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt $deadline } |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

# ---------- 测试邮件模式 ----------
if ($TestMail) {
  $config = Get-MailConfig
  if (-not $config.Ready) {
    Write-Log '测试失败：.env 中 MAIL_ADDRESS / MAIL_USERNAME / MAIL_PASSWORD 未配置完整' 'ERROR'
    exit 2
  }

  $body = @(
    '这是一封来自 douyin-auto-spark 本地定时任务的测试邮件。',
    '',
    ('主机：' + $env:COMPUTERNAME),
    ('时间：' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')),
    ('发件：' + $config.Address),
    ('收件：' + $config.To),
    ('SMTP：' + $config.Host + ':' + $config.Port),
    '',
    '收到这封信，说明后续续火失败时你也能收到告警。'
  ) -join [Environment]::NewLine

  try {
    Send-Mail -Config $config -Subject '[测试] 抖音续火失败通知通道' -Body $body
    Write-Log '测试邮件发送成功'
    exit 0
  } catch {
    Write-Log ('测试邮件发送失败：' + $_.Exception.Message) 'ERROR'
    exit 3
  }
}

# ---------- 正常运行模式 ----------
# 备用触发器用 -SkipIfDone 调用：当天已有成功记录就不再发第二遍。
# 用 .NET 按 UTF-8 读取，避免 PowerShell 5.1 把无 BOM 的 UTF-8 日志当 ANSI 而匹配不到中文。
if ($SkipIfDone) {
  $alreadySucceeded = (Test-Path $logFile) -and
    [System.IO.File]::ReadAllText($logFile, [System.Text.Encoding]::UTF8).Contains('续火任务成功，耗时')

  if ($alreadySucceeded) {
    Write-Log '今日已有成功记录（-SkipIfDone），跳过本次补跑'
    exit 0
  }

  Write-Log '今日尚未成功，开始补跑（-SkipIfDone）'
}

$config = Get-MailConfig
$startTime = Get-Date

if (-not $config.Ready) {
  Write-Log '未配置 MAIL_ADDRESS / MAIL_USERNAME / MAIL_PASSWORD，本次失败不会发邮件' 'WARN'
}

# 无人值守必须无头运行，否则会弹窗卡住；.env 里的值已被这里覆盖（dotenv 不覆盖已有环境变量）
$env:PLAYWRIGHT_HEADLESS = 'true'
$env:AUTO_CLOSE = 'true'

$tsxCmd = Join-Path $root 'node_modules\.bin\tsx.cmd'
if (-not (Test-Path $tsxCmd)) {
  Write-Log ('找不到 ' + $tsxCmd + '，请先在项目根目录执行 pnpm install') 'ERROR'
  exit 4
}

# 清掉上一次的失败截图，避免把旧图当成这次的现场
Get-ChildItem -Path $artifactsDir -Filter 'failure-screenshot-*.png' -File -ErrorAction SilentlyContinue |
  Remove-Item -Force -ErrorAction SilentlyContinue

Write-Log '========== 开始执行续火任务 =========='
Write-Log ('工作目录：' + $root)
Write-Log ('日志文件：' + $logFile)

$exitCode = $null
$failureReason = $null

try {
  # 【为什么必须显式重定向标准输出】计划任务里的 powershell 没有可见控制台，子进程会继承到
  # 无效的标准句柄。此时 cmd 一启动就以退出码 1 结束，连 ">> log 2>&1" 的重定向都来不及建立，
  # 外部表现就是：日志里没有一行 tsx 输出、artifacts 里没有失败截图、2 秒内失败。
  # 显式建立管道后 cmd 才有可用句柄，输出由脚本自己收回并写入主日志。
  # 【为什么不用 Start-Process -ArgumentList】它会给含空格的参数再补一层引号，破坏 cmd 的
  # "/c ""程序" 参数"" 结构；这里用 ProcessStartInfo 的 Arguments 原样传递。
  # 【为什么结尾必须补一个引号】cmd 解析 /c 后的字符串时，若首字符是引号，会剥掉首字符并
  # 删掉整行最后一个引号。少了结尾这个引号，被删掉的就是程序路径自己的收尾引号，
  # 程序名变成 "D:\...\tsx.cmd src\main.ts"（带空格），报“系统找不到指定的路径”。
  $cmdLine = '/c ""{0}" src\main.ts"' -f $tsxCmd
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $env:ComSpec
  $startInfo.Arguments = $cmdLine
  $startInfo.WorkingDirectory = $root
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $startInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8

  $process = [System.Diagnostics.Process]::Start($startInfo)
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()

  $finished = $process.WaitForExit($TimeoutMinutes * 60 * 1000)

  if (-not $finished) {
    & taskkill.exe /T /F /PID $process.Id | Out-Null
    $exitCode = -1
    $failureReason = '执行超时（超过 {0} 分钟），已强制结束' -f $TimeoutMinutes
  } else {
    $process.Refresh()
    $exitCode = $process.ExitCode
    if ($exitCode -ne 0) {
      $failureReason = '脚本退出码 {0}' -f $exitCode
    }
  }

  # 把子进程输出原样并入主日志，保持单文件日志的习惯
  foreach ($streamTask in @($stdoutTask, $stderrTask)) {
    try {
      $text = $streamTask.Result
      if ($text -and $text.Length -gt 0) {
        [System.IO.File]::AppendAllText($logFile, $text, $utf8NoBom)
      }
    } catch {
      Write-Log ('读取子进程输出失败：' + $_.Exception.Message) 'WARN'
    }
  }
} catch {
  $exitCode = -2
  $failureReason = '启动或等待过程异常：' + $_.Exception.Message
}

$duration = [int]((Get-Date) - $startTime).TotalSeconds

if ($exitCode -eq 0) {
  Write-Log ('续火任务成功，耗时 {0} 秒' -f $duration)
  Write-Result ('成功 | {0} | 耗时 {1} 秒' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $duration)
  Remove-ExpiredLogs
  exit 0
}

Write-Log ('续火任务失败：' + $failureReason) 'ERROR'
Write-Result ('失败 | {0} | {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $failureReason)

$screenshots = @(
  Get-ChildItem -Path $artifactsDir -Filter 'failure-screenshot-*.png' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -ge $startTime } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 3 |
    ForEach-Object { $_.FullName }
)

$tail = ''
if (Test-Path $logFile) {
  $tail = (Get-Content -Path $logFile -Tail 80 -Encoding UTF8) -join [Environment]::NewLine
}

$bodyLines = @(
  '抖音续火任务失败了，请尽快检查。',
  '',
  ('主机：' + $env:COMPUTERNAME),
  ('时间：' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')),
  ('结果：' + $failureReason),
  ('耗时：' + $duration + ' 秒'),
  ('日志：' + $logFile),
  ('截图：' + $(if ($screenshots.Count -gt 0) { $screenshots.Count.ToString() + ' 张，见附件' } else { '本次未生成截图' })),
  '',
  '常见原因：Cookie 失效（截图会停在登录页）、抖音聊天页改版导致选择器失效、好友昵称变更。',
  '',
  '----- 日志末尾 80 行 -----',
  $tail
)

if ($config.Ready) {
  try {
    $attachments = Copy-AttachmentsForMail -Paths $screenshots
    Send-Mail -Config $config -Subject ('[失败] 抖音续火 ' + (Get-Date -Format 'yyyy-MM-dd')) -Body ($bodyLines -join [Environment]::NewLine) -Attachments $attachments
    Write-Log ('已发送失败告警邮件到 ' + $config.To)
  } catch {
    Write-Log ('发送失败告警邮件失败：' + $_.Exception.Message) 'ERROR'
  }
}

Remove-ExpiredLogs
exit 5
