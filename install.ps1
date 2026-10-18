#!/usr/bin/env pwsh
#Requires -Version 5.1

param(
  [ValidateSet("chat-completions", "responses")]
  [string]$Transport
)

$sourceDir = Join-Path $PSScriptRoot "src"
if (-not (Test-Path (Join-Path $sourceDir "install-runtime.mjs"))) {
  throw "install.ps1 must run from a checked-out or extracted plugin repository."
}

# Not fatal: a configured apiKeyCommand can provide the key without putting it
# in the environment. The runtime validates that setting when OpenCode starts.
if (-not $env:SAIA_API_KEY) {
  Write-Host "Note: no SAIA_API_KEY is set in this shell. Get your key from https://chat-ai.academiccloud.de/ then either:"
  Write-Host "  [Environment]::SetEnvironmentVariable('SAIA_API_KEY', 'your_key_here', 'User')"
  Write-Host "  ...or set 'apiKeyCommand' in ~/.config/opencode/saia.json to read it from a password manager."
  Write-Host ""
}

$homeDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
$configDir = if ($env:OPENCODE_CONFIG_DIR) {
  $env:OPENCODE_CONFIG_DIR
} else {
  Join-Path $homeDir ".config\opencode"
}
$pluginsDir = Join-Path $configDir "plugins"
$targetDir = Join-Path $pluginsDir "saia"

& node (Join-Path $sourceDir "install-runtime.mjs") $sourceDir $configDir
if ($LASTEXITCODE -ne 0) {
  throw "Failed to install the SAIA runtime"
}

# Only write the transport when asked for it explicitly, so re-running the
# installer never silently resets an existing choice.
if ($PSBoundParameters.ContainsKey("Transport") -or -not (Test-Path (Join-Path $configDir "saia.json"))) {
  if (-not $Transport) {
    $Transport = "chat-completions"
  }

  & node (Join-Path $targetDir "set-saia-transport.mjs") $Transport $configDir
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to configure the SAIA API transport"
  }
}

$configFile = Join-Path $configDir "opencode.json"

if (-not (Test-Path $configFile)) {
  $config = @{
    '$schema' = "https://opencode.ai/config.json"
  } | ConvertTo-Json -Depth 10
  $config | Set-Content $configFile -Encoding UTF8
  Write-Host "✓ Created $configFile"
}

Write-Host ""
Write-Host "✓ Plugin installed to $targetDir"
Write-Host "  OpenCode 2 plugin directory: $targetDir (server.js and tui.tsx)"
$transportLabel = $Transport
if (-not $transportLabel) {
  $transportLabel = "configured setting or chat-completions default"
}
Write-Host "  API transport: $transportLabel"
Write-Host "Run 'opencode' in any project to use SAIA models"
