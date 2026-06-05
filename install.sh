#!/usr/bin/env bash
#
# Azure Panel 一键安装脚本（aaPanel / Linux）
# 首次部署：克隆代码 → 自动建库 → 配置 .env → 构建 → Supervisor → 健康检查
#
# 用法:
#   chmod +x install.sh
#   sudo ./install.sh
#
# 非交互安装:
#   NON_INTERACTIVE=1 sudo ./install.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_URL="${REPO_URL:-https://github.com/kexue-aihao/Azure-Panel.git}"
GIT_BRANCH="${GIT_BRANCH:-master}"
APP_DIR="${APP_DIR:-$SCRIPT_DIR}"
RAW_BASE="${RAW_BASE:-https://raw.githubusercontent.com/kexue-aihao/Azure-Panel/master}"

# 内联 Node PATH 修复（在 source common.sh 之前生效，兼容旧版 common.sh）
_bootstrap_node_path() {
	local d npm_path
	if command -v npm >/dev/null 2>&1; then return 0; fi
	if [[ -n "${NODE_BIN_DIR:-}" && -x "${NODE_BIN_DIR}/npm" ]]; then
		export PATH="${NODE_BIN_DIR}:${PATH}"
		return 0
	fi
	if [[ -d /www/server/nvm/versions/node ]]; then
		for d in $(ls -1 /www/server/nvm/versions/node 2>/dev/null | sort -V -r); do
			if [[ -x "/www/server/nvm/versions/node/${d}/bin/npm" ]]; then
				export PATH="/www/server/nvm/versions/node/${d}/bin:${PATH}"
				return 0
			fi
		done
	fi
	for npm_path in /www/server/nvm/versions/node/v*/bin/npm /www/server/nodejs/v*/bin/npm; do
		[[ -x "$npm_path" ]] || continue
		export PATH="$(dirname "$npm_path"):${PATH}"
		return 0
	done
	return 1
}
_bootstrap_node_path || true

# ---------- 引导：确保完整项目文件存在并同步到最新 ----------
bootstrap_repo() {
	local common_file="${APP_DIR}/deploy/aapanel/common.sh"

	command -v git >/dev/null 2>&1 || {
		echo "[error] 未找到 git，请先安装: apt install git / yum install git"
		exit 1
	}

	mkdir -p "$APP_DIR"

	if [[ -d "${APP_DIR}/.git" ]]; then
		echo "[bootstrap] 同步远程最新代码（覆盖本地 install.sh/update.sh 修改）..."
		git -C "$APP_DIR" fetch origin "$GIT_BRANCH" 2>/dev/null || true
		git -C "$APP_DIR" checkout "$GIT_BRANCH" 2>/dev/null || true
		if [[ "${SKIP_GIT_RESET:-0}" != "1" ]]; then
			git -C "$APP_DIR" reset --hard "origin/${GIT_BRANCH}" 2>/dev/null \
				|| git -C "$APP_DIR" pull origin "$GIT_BRANCH" 2>/dev/null || true
		else
			git -C "$APP_DIR" pull origin "$GIT_BRANCH" 2>/dev/null || true
		fi
	elif [[ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]]; then
		# 目录非空（例如只有 curl 下载的 install.sh），强制同步仓库文件
		echo "[bootstrap] 目录已有文件，从仓库同步..."
		cd "$APP_DIR"
		git init
		git remote remove origin 2>/dev/null || true
		git remote add origin "$REPO_URL"
		git fetch origin "$GIT_BRANCH" --depth=1
		git reset --hard "origin/${GIT_BRANCH}"
		git clean -fd
	else
		echo "[bootstrap] 克隆仓库 -> $APP_DIR"
		git clone --branch "$GIT_BRANCH" --depth=1 "$REPO_URL" "$APP_DIR"
	fi

	# 兜底：git 失败时从 GitHub 直接下载关键文件
	if [[ ! -f "$common_file" ]] && command -v curl >/dev/null 2>&1; then
		echo "[bootstrap] git 同步不完整，从 GitHub 下载关键文件..."
		mkdir -p "${APP_DIR}/deploy/aapanel"
		curl -fsSL "${RAW_BASE}/deploy/aapanel/common.sh" -o "$common_file"
		curl -fsSL "${RAW_BASE}/install.sh" -o "${APP_DIR}/install.sh"
		curl -fsSL "${RAW_BASE}/update.sh" -o "${APP_DIR}/update.sh"
		chmod +x "${APP_DIR}/install.sh" "${APP_DIR}/update.sh" 2>/dev/null || true
	fi

	[[ -f "$common_file" ]] || {
		echo "[error] 拉取代码失败，未找到 deploy/aapanel/common.sh"
		echo "[error] 请手动执行: git clone -b master $REPO_URL $APP_DIR"
		exit 1
	}

	echo "[bootstrap] 代码同步完成"
}

bootstrap_repo

# 同步后重新执行最新 install.sh（确保使用远程最新逻辑）
if [[ "${AZURE_PANEL_INSTALL_REEXEC:-}" != "1" ]]; then
	export AZURE_PANEL_INSTALL_REEXEC=1
	cd "$APP_DIR"
	exec bash "${APP_DIR}/install.sh" "$@"
fi

cd "$APP_DIR"
_bootstrap_node_path || true

# shellcheck source=deploy/aapanel/common.sh
source "${APP_DIR}/deploy/aapanel/common.sh"

# ---------- 可配置项 ----------
APP_DIR="${APP_DIR:-$SCRIPT_DIR}"
MYSQL_HOST="${MYSQL_HOST:-127.0.0.1}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
MYSQL_USER="${MYSQL_USER:-azure_panel}"
MYSQL_DATABASE="${MYSQL_DATABASE:-azure_panel}"
APP_PORT="${APP_PORT:-3000}"
WEB_PROGRAM="${WEB_PROGRAM:-azure-panel-web}"
WORKER_PROGRAM="${WORKER_PROGRAM:-azure-panel-worker}"
DOMAIN="${DOMAIN:-}"

banner() {
	echo ""
	info "╔══════════════════════════════════════════════╗"
	info "║       Azure Panel 一键安装 (aaPanel)       ║"
	info "╚══════════════════════════════════════════════╝"
	echo ""
}

check_prerequisites() {
	log "检查运行环境..."
	require_cmd git
	require_node_tools

	if [[ "${EUID}" -ne 0 ]]; then
		warn "建议使用 root 或 sudo 运行，以便写入 Supervisor 配置"
	fi

	local node_ver
	node_ver="$(node -v | sed 's/v//' | cut -d. -f1)"
	if [[ "$node_ver" -lt 18 ]]; then
		die "Node.js 版本过低 ($(node -v))，请安装 Node 20 LTS"
	fi
	log "Node $(node -v) | npm $(npm -v)"
	log "项目目录: $APP_DIR"
}

sync_latest_code() {
	if [[ ! -d "${APP_DIR}/.git" ]]; then
		return
	fi
	log "同步最新代码..."
	git fetch origin 2>/dev/null || true
	git checkout "$GIT_BRANCH" 2>/dev/null || true
	git pull origin "$GIT_BRANCH" 2>/dev/null || warn "git pull 失败，继续使用本地代码"
}

collect_config() {
	log "收集安装配置..."

	prompt_or_env MYSQL_HOST "MySQL 主机" "$MYSQL_HOST"
	prompt_or_env MYSQL_PORT "MySQL 端口" "$MYSQL_PORT"
	prompt_or_env MYSQL_USER "MySQL 用户名" "$MYSQL_USER"
	prompt_or_env MYSQL_DATABASE "MySQL 数据库名" "$MYSQL_DATABASE"
	prompt_or_env APP_PORT "应用监听端口" "$APP_PORT"
	prompt_or_env DOMAIN "绑定域名（可留空稍后配置）" "$DOMAIN"

	if [[ -z "${MYSQL_PASSWORD:-}" ]]; then
		MYSQL_PASSWORD="$(rand_hex 16)"
		log "已自动生成数据库密码 (${MYSQL_USER})"
	elif [[ "${NON_INTERACTIVE:-0}" != "1" ]]; then
		info "使用环境变量中的 MYSQL_PASSWORD"
	fi

	SECRET_KEY="${SECRET_KEY:-$(rand_hex 48)}"
	ENCRYPTION_KEY="${ENCRYPTION_KEY:-$(rand_hex 16)$(rand_hex 16)}"
}

setup_env() {
	if [[ -f .env && "${FORCE_ENV:-0}" != "1" ]]; then
		warn ".env 已存在，跳过生成（如需覆盖请设置 FORCE_ENV=1）"
		return
	fi

	log "生成 .env 配置文件..."
	write_env_file ".env" \
		"$MYSQL_HOST" "$MYSQL_PORT" "$MYSQL_USER" "$MYSQL_PASSWORD" "$MYSQL_DATABASE" \
		"$SECRET_KEY" "$ENCRYPTION_KEY" "$APP_PORT"
	chmod 600 .env 2>/dev/null || true
}

setup_mysql() {
	if [[ "${SKIP_MYSQL:-0}" == "1" ]]; then
		warn "已跳过数据库步骤 (SKIP_MYSQL=1)"
		return
	fi

	local schema="${APP_DIR}/deploy/aapanel/schema.mysql.sql"
	local cred_file="${APP_DIR}/deploy/aapanel/generated/db-credentials.txt"
	[[ -f "$schema" ]] || die "未找到数据库脚本: $schema"

	if ! command -v mysql >/dev/null 2>&1; then
		die "未找到 mysql 客户端，请先在 aaPanel 安装 MySQL"
	fi

	if [[ "${SKIP_CREATE_DB:-0}" != "1" ]]; then
		if test_mysql_app_connection "$MYSQL_HOST" "$MYSQL_PORT" "$MYSQL_USER" "$MYSQL_PASSWORD"; then
			log "数据库用户已存在且可连接，跳过建库"
		else
			create_mysql_database_and_user \
				"$MYSQL_HOST" "$MYSQL_PORT" "$MYSQL_USER" "$MYSQL_PASSWORD" "$MYSQL_DATABASE"
		fi
	else
		warn "已跳过自动建库 (SKIP_CREATE_DB=1)"
	fi

	test_mysql_app_connection "$MYSQL_HOST" "$MYSQL_PORT" "$MYSQL_USER" "$MYSQL_PASSWORD" \
		|| die "数据库连接失败，请检查 MySQL 服务与账号"

	import_mysql_schema "$schema" "$MYSQL_HOST" "$MYSQL_PORT" \
		"$MYSQL_USER" "$MYSQL_PASSWORD" "$MYSQL_DATABASE"
	log "数据库表结构导入完成"

	mkdir -p "${APP_DIR}/deploy/aapanel/generated"
	cat >"$cred_file" <<EOF
# Azure Panel 数据库凭据（install.sh 自动生成，请妥善保管）
MYSQL_HOST=${MYSQL_HOST}
MYSQL_PORT=${MYSQL_PORT}
MYSQL_DATABASE=${MYSQL_DATABASE}
MYSQL_USER=${MYSQL_USER}
MYSQL_PASSWORD=${MYSQL_PASSWORD}
EOF
	chmod 600 "$cred_file" 2>/dev/null || true
	info "数据库凭据已保存: $cred_file"
}

setup_supervisor() {
	if [[ "${SKIP_SUPERVISOR:-0}" == "1" ]]; then
		warn "已跳过 Supervisor 配置 (SKIP_SUPERVISOR=1)"
		return
	fi

	local node_bin
	node_bin="$(find_node_bin)"
	mkdir -p /www/wwwlogs 2>/dev/null || true

	write_supervisor_configs "$node_bin" "$APP_DIR" "$APP_PORT" "$WEB_PROGRAM" "$WORKER_PROGRAM"
	supervisor_reload_and_start "$WEB_PROGRAM" "$WORKER_PROGRAM" || true
}

verify_or_hint_supervisor() {
	local port
	port="$(read_port_from_env "${APP_DIR}/.env" "$APP_PORT")"
	if [[ "${SKIP_HEALTHCHECK:-0}" == "1" ]]; then
		return
	fi
	sleep 2
	if command -v curl >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
		return
	fi
	print_supervisor_fix_hint "$APP_DIR" "$WEB_PROGRAM" "$WORKER_PROGRAM"
}

main() {
	banner
	check_prerequisites
	sync_latest_code
	collect_config
	setup_env
	setup_mysql
	npm_build_all
	setup_supervisor
	verify_or_hint_supervisor

	local port
	port="$(read_port_from_env "${APP_DIR}/.env" "$APP_PORT")"

	if [[ "${SKIP_HEALTHCHECK:-0}" != "1" ]]; then
		health_check "$port" || true
	fi

	echo ""
	log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	log "安装完成！"
	log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	info "项目目录 : $APP_DIR"
	info "监听地址 : http://127.0.0.1:${port}"
	info "数据库   : ${MYSQL_DATABASE} (用户: ${MYSQL_USER})"
	info "DB 凭据  : ${APP_DIR}/deploy/aapanel/generated/db-credentials.txt"
	info "Supervisor: $WEB_PROGRAM, $WORKER_PROGRAM"
	info "日志目录 : /www/wwwlogs/"
	echo ""
	print_nginx_hint "$port" "$DOMAIN"
	log "浏览器访问域名后注册账号即可使用"
	log "后续升级: cd $APP_DIR && ./update.sh"
	echo ""
}

main "$@"
