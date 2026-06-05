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
APP_DIR="${APP_DIR:-$SCRIPT_DIR}"
GIT_BRANCH="${GIT_BRANCH:-master}"

# 内联 Node PATH（aaPanel root 环境）
if ! command -v npm >/dev/null 2>&1; then
	for _d in $(ls -1 /www/server/nvm/versions/node 2>/dev/null | sort -V -r); do
		[[ -x "/www/server/nvm/versions/node/${_d}/bin/npm" ]] && export PATH="/www/server/nvm/versions/node/${_d}/bin:${PATH}" && break
	done
fi

# 若 common.sh 不存在，尝试从 GitHub 同步完整代码
if [[ ! -f "${APP_DIR}/deploy/aapanel/common.sh" ]]; then
	echo "[bootstrap] 缺少 deploy/aapanel/common.sh，正在同步代码..."
	command -v git >/dev/null 2>&1 || { echo "[error] 未找到 git"; exit 1; }
	REPO_URL="${REPO_URL:-https://github.com/kexue-aihao/Azure-Panel.git}"
	GIT_BRANCH="${GIT_BRANCH:-master}"
	if [[ -d "${APP_DIR}/.git" ]]; then
		git -C "$APP_DIR" fetch origin "$GIT_BRANCH" 2>/dev/null || true
		if [[ "${SKIP_GIT_RESET:-0}" != "1" ]]; then
			git -C "$APP_DIR" reset --hard "origin/${GIT_BRANCH}" 2>/dev/null || true
		else
			git -C "$APP_DIR" pull origin "$GIT_BRANCH" || true
		fi
	else
		cd "$APP_DIR"
		git init
		git remote add origin "$REPO_URL" 2>/dev/null || git remote set-url origin "$REPO_URL"
		git fetch origin "$GIT_BRANCH" --depth=1
		git reset --hard "origin/${GIT_BRANCH}"
	fi
fi

cd "$APP_DIR"
# shellcheck source=deploy/aapanel/common.sh
source "${APP_DIR}/deploy/aapanel/common.sh"

# ---------- 可配置项 ----------
APP_DIR="${APP_DIR:-$SCRIPT_DIR}"
GIT_BRANCH="${GIT_BRANCH:-master}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
REPO_URL="${REPO_URL:-https://github.com/kexue-aihao/Azure-Panel.git}"
WEB_PROGRAM="${WEB_PROGRAM:-azure-panel-web}"
WORKER_PROGRAM="${WORKER_PROGRAM:-azure-panel-worker}"
HEALTH_PORT="${HEALTH_PORT:-3000}"

log() { echo -e "${GREEN}[update]${NC} $*"; }

# ---------- 前置检查 ----------
require_cmd git
require_node_tools

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
	if [[ "${SKIP_GIT_RESET:-0}" != "1" ]]; then
		log "同步远程代码（丢弃本地修改）..."
		git reset --hard "$GIT_REMOTE/$GIT_BRANCH"
	else
		git pull "$GIT_REMOTE" "$GIT_BRANCH"
	fi
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
fix_env_file_permissions ".env"

# ---------- 安装依赖 & 构建 ----------
if env_uses_mysql ".env"; then
	repair_mysql_from_env ".env" "$APP_DIR" || warn "MySQL 自检/修复未完成，后续健康检查可能失败"
fi

npm_build_all

# ---------- 重启 Supervisor / aaPanel Node 项目 ----------
if [[ "${SKIP_SUPERVISOR:-0}" != "1" ]]; then
	if restart_aapanel_node_projects "${AAPANEL_WEB_PROJECT_NAME:-Azure-Panel}" "$WORKER_PROGRAM" 2>/dev/null; then
		log "已通过 aaPanel 重启 Node 项目"
	else
		restart_supervisor_programs "$WEB_PROGRAM" "$WORKER_PROGRAM" || true
	fi
else
	warn "已跳过进程重启 (SKIP_SUPERVISOR=1)"
fi

# ---------- 健康检查 ----------
if [[ "${SKIP_HEALTHCHECK:-0}" != "1" ]]; then
	health_check "$HEALTH_PORT" || true
fi

log "升级完成！当前版本: $(git rev-parse --short HEAD)"
