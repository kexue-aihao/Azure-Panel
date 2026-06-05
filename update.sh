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

# ---------- 可配置项 ----------
APP_DIR="${APP_DIR:-/www/wwwroot/azure-panel}"
GIT_BRANCH="${GIT_BRANCH:-master}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
REPO_URL="${REPO_URL:-https://github.com/kexue-aihao/Azure-Panel.git}"
WEB_PROGRAM="${WEB_PROGRAM:-azure-panel-web}"
WORKER_PROGRAM="${WORKER_PROGRAM:-azure-panel-worker}"
HEALTH_PORT="${HEALTH_PORT:-3000}"

# ---------- 颜色输出 ----------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[update]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }
err()  { echo -e "${RED}[error]${NC} $*" >&2; }

die() {
	err "$1"
	exit 1
}

# ---------- 前置检查 ----------
require_cmd() {
	command -v "$1" >/dev/null 2>&1 || die "未找到命令: $1，请先安装"
}

require_cmd git
require_cmd npm
require_cmd node

# ---------- 进入项目目录 ----------
if [[ ! -d "$APP_DIR" ]]; then
	log "目录不存在，正在克隆仓库到 $APP_DIR ..."
	mkdir -p "$(dirname "$APP_DIR")"
	git clone --branch "$GIT_BRANCH" "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
log "工作目录: $(pwd)"

# ---------- 拉取最新代码 ----------
if [[ ! -d .git ]]; then
	die "当前目录不是 Git 仓库，请确认 APP_DIR 或先执行 git clone"
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
		die "缺少 .env 文件，请先手动创建"
	fi
fi

# 从 .env 读取 PORT（若存在）
if [[ -z "${HEALTH_PORT_SET:-}" ]]; then
	ENV_PORT="$(grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
	[[ -n "$ENV_PORT" ]] && HEALTH_PORT="$ENV_PORT"
fi

# ---------- 安装依赖 & 构建 ----------
log "安装 npm 依赖..."
npm install --production=false

log "构建 Web + Worker..."
npm run build:all

[[ -f build/index.js ]] || die "构建失败: 未找到 build/index.js"
[[ -f build/worker.js ]]  || die "构建失败: 未找到 build/worker.js"

log "构建完成"

# ---------- 重启 Supervisor ----------
restart_supervisor() {
	local ctl=""

	if command -v supervisorctl >/dev/null 2>&1; then
		ctl="supervisorctl"
	elif [[ -x /www/server/panel/pyenv/bin/supervisorctl ]]; then
		ctl="/www/server/panel/pyenv/bin/supervisorctl"
	fi

	if [[ -z "$ctl" ]]; then
		warn "未找到 supervisorctl，请手动在 aaPanel 重启 $WEB_PROGRAM 和 $WORKER_PROGRAM"
		return 0
	fi

	log "重启 Supervisor 进程: $WEB_PROGRAM, $WORKER_PROGRAM"
	if $ctl restart "$WEB_PROGRAM" "$WORKER_PROGRAM" 2>/dev/null; then
		log "Supervisor 重启成功"
	else
		warn "批量重启失败，尝试分别重启..."
		$ctl restart "$WEB_PROGRAM" || warn "重启 $WEB_PROGRAM 失败"
		$ctl restart "$WORKER_PROGRAM" || warn "重启 $WORKER_PROGRAM 失败"
	fi
}

if [[ "${SKIP_SUPERVISOR:-0}" != "1" ]]; then
	restart_supervisor
else
	warn "已跳过 Supervisor 重启 (SKIP_SUPERVISOR=1)"
fi

# ---------- 健康检查 ----------
if [[ "${SKIP_HEALTHCHECK:-0}" != "1" ]]; then
	log "健康检查 http://127.0.0.1:${HEALTH_PORT}/api/health ..."
	sleep 2
	if command -v curl >/dev/null 2>&1; then
		if curl -fsS "http://127.0.0.1:${HEALTH_PORT}/api/health" >/dev/null; then
			log "健康检查通过"
		else
			warn "健康检查未通过，请查看 Supervisor 日志"
		fi
	else
		warn "未安装 curl，跳过健康检查"
	fi
fi

log "升级完成！当前版本: $(git rev-parse --short HEAD)"
