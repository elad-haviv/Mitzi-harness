# Installs or updates Mitzi on Windows.
#   irm https://raw.githubusercontent.com/elad-haviv/Mitzi-harness/feature/web-ui/install.ps1 | iex
$ErrorActionPreference = 'Stop'

$Repo = 'https://github.com/elad-haviv/Mitzi-harness.git'
$Branch = if ($env:MITZI_BRANCH) { $env:MITZI_BRANCH } else { 'feature/web-ui' }
$Dir = if ($env:MITZI_DIR) { $env:MITZI_DIR } else { Join-Path $HOME '.mitzi\app' }
$Bin = Join-Path $HOME '.mitzi\bin'

function Say($msg) { Write-Host "* $msg" -ForegroundColor DarkYellow }
function Die($msg) { Write-Host "x $msg" -ForegroundColor Red; exit 1 }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die 'git is required. Install it from https://git-scm.com and run this again.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die 'Node.js 20 or newer is required. Install it from https://nodejs.org and run this again.' }
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 20) { Die "Node.js 20 or newer is required (found $(node --version)). Update it from https://nodejs.org." }

# git and npm write progress to stderr; don't let that count as failure.
$ErrorActionPreference = 'Continue'
if (Test-Path (Join-Path $Dir '.git')) {
  Say "Updating Mitzi in $Dir"
  git -C $Dir fetch --quiet origin $Branch
  git -C $Dir checkout --quiet -B $Branch "origin/$Branch"
} else {
  Say "Downloading Mitzi to $Dir"
  New-Item -ItemType Directory -Force -Path (Split-Path $Dir) | Out-Null
  git clone --quiet --branch $Branch $Repo $Dir
}
if ($LASTEXITCODE -ne 0) { Die 'Downloading Mitzi failed.' }

Push-Location $Dir
try {
  Say 'Installing dependencies'
  npm ci --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { Die 'npm ci failed.' }
  Say 'Building'
  npm run --silent build | Out-Null
  if ($LASTEXITCODE -ne 0) { Die 'Build failed.' }
} finally {
  Pop-Location
}
$ErrorActionPreference = 'Stop'

# A small launcher on the user's PATH.
New-Item -ItemType Directory -Force -Path $Bin | Out-Null
Set-Content -Path (Join-Path $Bin 'mitzi.cmd') -Encoding ASCII -Value "@node `"$Dir\dist\index.js`" %*"
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($userPath -split ';' | Where-Object { $_ -eq $Bin })) {
  [Environment]::SetEnvironmentVariable('Path', ($(if ($userPath) { "$userPath;" } else { '' }) + $Bin), 'User')
  $env:Path = "$env:Path;$Bin"
}

# Desktop and Start menu shortcuts that open the app.
$shell = New-Object -ComObject WScript.Shell
$targets = @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('Programs')) ''))
foreach ($folder in $targets) {
  $link = $shell.CreateShortcut((Join-Path $folder 'Mitzi.lnk'))
  $link.TargetPath = Join-Path $Bin 'mitzi.cmd'
  $link.Arguments = 'ui'
  $link.WorkingDirectory = $HOME
  $link.Description = 'Mitzi AI workspace'
  $link.Save()
}

Say "Installed. Open 'Mitzi' from your desktop or Start menu, or run:  mitzi ui"
Write-Host '(Open a new terminal window first so the mitzi command is found.)'
