#!/usr/bin/env bash
#
# Azure Panel 源站一键升级脚本（aaPanel / Linux）
# 从 Git 仓库拉取最新代码，安装依赖、构建并重启 Supervisor 进程。
#
# 用法:
#   chmod +x update.sh
#   ./update.sh
#
# 可选环境变量（部署前按需 export）:
#   APP_DIR=/www/wwwroot/azure-panel
#   GIT_BRANCH=master
#   GIT_REMOTE=origin
#   REPO_URL=https://github.com/kexue-aihao/Azure-Panel.git
#   WEB_PROGRAM=azure-panel-web
#   WORKER_PROGRAM=azure-panel-worker
#   SKIP_SUPERVISOR=1          # 仅更新代码不重启进程
#   SKIP_HEALTHCHECK=1         # 跳过健康检查
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/aapanel/common.sh
source "${SCRIPT_DIR}/deploy/aapanel/common.sh"

# ---------- 可配置项 ----------
APP_DIR="${APP_DIR:-/www/wwwroot/azure-panel}"
GIT_BRANCH="${GIT_BRANCH:-master}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
REPO_URL="${REPO_URL:-https://github.com/kexue-aihao/Azure-Panel.git}"
WEB_PROGRAM="${WEB_PROGRAM:-azure-panel-web}"
WORKER_PROGRAM="${WORKER_PROGRAM:-azure-panel-worker}"
HEALTH_PORT="${HEALTH_PORT:-3000}"

log() { echo -e "${GREEN}[update]${NC} $*"; }

# ---------- 前置检查 ----------
require_cmd git
require_cmd npm
require_cmd node

# ---------- 进入项目目录 ----------
if [[ -f "${SCRIPT_DIR}/package.json" ]]; then
	APP_DIR="${APP_DIR:-$SCRIPT_DIR}"
fi

if [[ ! -d "$APP_DIR" ]]; then
	die "项目目录不存在: $APP_DIR，请先运行 ./install.sh"
fi

cd "$APP_DIR"
log "工作目录: $(pwd)"

# ---------- 拉取最新代码 ----------
if [[ ! -d .git ]]; then
	die "当前目录不是 Git 仓库，请确认 APP_DIR 或先执行 install.sh"
fi

log "获取远程更新 ($GIT_REMOTE/$GIT_BRANCH) ..."
git fetch "$GIT_REMOTE"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "$GIT_REMOTE/$GIT_BRANCH")"

if [[ "$LOCAL" == "$REMOTE" ]]; then
	warn "代码已是最新 ($LOCAL)，继续执行依赖检查与构建..."
else
	log "更新: $LOCAL -> $REMOTE"
	git checkout "$GIT_BRANCH" 2>/dev/null || git checkout -b "$GIT_BRANCH" "$GIT_REMOTE/$GIT_BRANCH"
	git pull "$GIT_REMOTE" "$GIT_BRANCH"
fi

# ---------- 环境文件 ----------
if [[ ! -f .env ]]; then
	if [[ -f .env.example ]]; then
		warn ".env 不存在，从 .env.example 复制（请尽快修改密钥与数据库配置）"
		cp .env.example .env
	else
		die "缺少 .env 文件，请先运行 install.sh 或手动创建"
	fi
fi

HEALTH_PORT="$(read_port_from_env .env "$HEALTH_PORT")"

# ---------- 安装依赖 & 构建 ----------
npm_build_all

# ---------- 重启 Supervisor ----------
if [[ "${SKIP_SUPERVISOR:-0}" != "1" ]]; then
	restart_supervisor_programs "$WEB_PROGRAM" "$WORKER_PROGRAM" || true
else
	warn "已跳过 Supervisor 重启 (SKIP_SUPERVISOR=1)"
fi

# ---------- 健康检查 ----------
if [[ "${SKIP_HEALTHCHECK:-0}" != "1" ]]; then
	health_check "$HEALTH_PORT" || true
fi

log "升级完成！当前版本: $(git rev-parse --short HEAD)"
