# get-token.ps1 — One-click cTrader OAuth2 token helper
# Opens browser, you login & allow, paste the redirect URL, done.

param(
  [string]$clientId,
  [string]$clientSecret,
  [string]$redirectUri = "https://openapi.ctrader.com"
)

# ── Config ──────────────────────────────────────────────
# Edit these or pass as params:
#   .\get-token.ps1 -clientId "YOUR_ID" -clientSecret "YOUR_SECRET"
if (-not $clientId) { $clientId = Read-Host "Enter your Client ID" }
if (-not $clientSecret) { $clientSecret = Read-Host -AsSecureString "Enter your Client Secret"; $clientSecret = [System.Net.NetworkCredential]::new("", $clientSecret).Password }

# ── Step 1: Open auth URL in browser ───────────────────
$authUrl = "https://id.ctrader.com/my/settings/openapi/grantingaccess/?client_id=$clientId&redirect_uri=$([System.Web.HttpUtility]::UrlEncode($redirectUri))&scope=trading&product=web"

Write-Host "`n🔗 Opening browser for cTrader login..." -ForegroundColor Cyan
Write-Host "   URL: $authUrl`n" -ForegroundColor Gray
Start-Process $authUrl

# ── Step 2: Paste the redirect URL ─────────────────────
Write-Host "👉 After logging in and clicking 'Allow access'," -ForegroundColor Yellow
Write-Host "   paste the ENTIRE redirect URL from the address bar here." -ForegroundColor Yellow
$redirectedUrl = Read-Host "`nPaste URL"

# ── Step 3: Extract code ───────────────────────────────
$code = ""
if ($redirectedUrl -match "code=([^&\s]+)") {
  $code = $matches[1]
} else {
  Write-Host "❌ Could not find 'code=' in that URL. Try again." -ForegroundColor Red
  exit 1
}

Write-Host "`n📋 Authorization code extracted (expires in 60s, exchanging...)`n" -ForegroundColor Cyan

# ── Step 4: Exchange code for tokens ───────────────────
try {
  $body = "grant_type=authorization_code&code=$code&redirect_uri=$([System.Web.HttpUtility]::UrlEncode($redirectUri))&client_id=$clientId&client_secret=$clientSecret"
  $res = Invoke-RestMethod -Uri "https://openapi.ctrader.com/apps/token" `
    -Method Post `
    -Body $body `
    -ContentType "application/x-www-form-urlencoded" `
    -ErrorAction Stop

  Write-Host "✅ SUCCESS!" -ForegroundColor Green
  Write-Host "`n────────────────────────────────────────────────" -ForegroundColor Gray
  Write-Host "  Access Token:  $($res.accessToken.Substring(0, 40))..." -ForegroundColor Green
  Write-Host "  Refresh Token: $($res.refreshToken)" -ForegroundColor Green
  Write-Host "  Expires In:    $($res.expiresIn) seconds (~$([math]::Round($res.expiresIn / 86400)) days)" -ForegroundColor Green
  Write-Host "────────────────────────────────────────────────" -ForegroundColor Gray

  # Save to file
  $outPath = Join-Path $PSScriptRoot ".ctrader-tokens.json"
  @{
    accessToken = $res.accessToken
    refreshToken = $res.refreshToken
    expiresIn = $res.expiresIn
    obtainedAt = (Get-Date -Format "o")
  } | ConvertTo-Json | Out-File $outPath -Encoding UTF8

  Write-Host "`n💾 Tokens saved to: $outPath" -ForegroundColor Gray
  
  # Suggest Railway command
  Write-Host "`n📋 Set on Railway:" -ForegroundColor Cyan
  Write-Host "   railway vars set CTRADER_REFRESH_TOKEN=$($res.refreshToken)" -ForegroundColor White
  Write-Host "`n📋 Or for quick test (hardcoded, lasts 30 days):" -ForegroundColor Cyan
  Write-Host "   railway vars set CTRADER_ACCESS_TOKEN=$($res.accessToken)" -ForegroundColor White

} catch {
  Write-Host "❌ FAILED: $($_.Exception.Message)" -ForegroundColor Red
  if ($_.Exception.Response) {
    $reader = $_.Exception.Response.GetResponseStream()
    $body = [System.IO.StreamReader]::new($reader).ReadToEnd()
    Write-Host "   Body: $body" -ForegroundColor Red
  }
  exit 1
}
