$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
	Write-Host "未找到 npm。请先安装 Node.js LTS: https://nodejs.org/" -ForegroundColor Red
	exit 1
}

if (-not (Test-Path "node_modules")) {
	Write-Host "正在安装依赖..."
	npm install
}

if (-not (Test-Path ".env")) {
	Copy-Item ".env.example" ".env"
	Write-Host "已创建 .env，请编辑 SECRET_KEY 和 ENCRYPTION_KEY"
}

npm run dev
