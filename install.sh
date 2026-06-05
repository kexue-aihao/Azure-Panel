#!/usr/bin/env bash
#
# Azure Panel 一键安装脚本（aaPanel / Linux）
# 首次部署：克隆代码 → 配置 .env → 导入数据库 → 构建 → Supervisor → 健康检查
#
# 用法:
#   chmod +x install.sh
#   sudo ./install.sh
#
# 非交互安装（CI / 脚本化）:
#   NON_INTERACTIVE=1 sudo ./install.sh
#   # 数据库密码自动生成；也可指定:
#   MYSQL_PASSWORD=your-db-pass MYSQL_ROOT_PASSWORD=root-pass sudo ./install.sh
#
# 可选环境变量:
#   APP_DIR=/www/wwwroot/azure-panel
#   REPO_URL=https://github.com/kexue-aihao/Azure-Panel.git
#   GIT_BRANCH=master
#   MYSQL_HOST=127.0.0.1
#   MYSQL_PORT=3306
#   MYSQL_USER=azure_panel
#   MYSQL_PASSWORD=数据库密码（留空则自动生成）
#   MYSQL_ROOT_PASSWORD=MySQL root 密码（留空则尝试读取 aaPanel 配置）
#   SKIP_CREATE_DB=1          # 跳过自动建库（数据库已存在时）
#   MYSQL_DATABASE=azure_panel
#   APP_PORT=3000
#   DOMAIN=panel.example.com
#   SKIP_MYSQL=1              # 跳过数据库导入
#   SKIP_SUPERVISOR=1         # 跳过 Supervisor 配置
#   SKIP_HEALTHCHECK=1
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/aapanel/common.sh
source "${SCRIPT_DIR}/deploy/aapanel/common.sh"

# ---------- 可配置项 ----------
# 若在项目目录内执行 install.sh，自动识别当前路径
if [[ -f "${SCRIPT_DIR}/package.json" ]]; then
	_DEFAULT_APP_DIR="$SCRIPT_DIR"
else
	_DEFAULT_APP_DIR="/www/wwwroot/azure-panel"
fi
APP_DIR="${APP_DIR:-$_DEFAULT_APP_DIR}"
REPO_URL="${REPO_URL:-https://github.com/kexue-aihao/Azure-Panel.git}"
GIT_BRANCH="${GIT_BRANCH:-master}"
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
	require_cmd npm
	require_cmd node

	if [[ "${EUID}" -ne 0 ]]; then
		warn "建议使用 root 或 sudo 运行，以便写入 Supervisor 配置"
	fi

	local node_ver
	node_ver="$(node -v | sed 's/v//' | cut -d. -f1)"
	if [[ "$node_ver" -lt 18 ]]; then
		die "Node.js 版本过低 ($(node -v))，请安装 Node 20 LTS"
	fi
	log "Node $(node -v) | npm $(npm -v)"
}

clone_or_use_existing() {
	if [[ -d "$APP_DIR/.git" ]]; then
		log "使用已有项目目录: $APP_DIR"
		cd "$APP_DIR"
		if [[ -d .git ]]; then
			log "拉取最新代码..."
			git fetch origin 2>/dev/null || true
			git checkout "$GIT_BRANCH" 2>/dev/null || true
			git pull origin "$GIT_BRANCH" 2>/dev/null || warn "git pull 失败，继续使用本地代码"
		fi
		return
	fi

	if [[ -d "$APP_DIR" && -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]]; then
		die "目录 $APP_DIR 已存在且非 Git 仓库，请清空后重试或设置其他 APP_DIR"
	fi

	log "克隆仓库 -> $APP_DIR"
	mkdir -p "$(dirname "$APP_DIR")"
	git clone --branch "$GIT_BRANCH" "$REPO_URL" "$APP_DIR"
	cd "$APP_DIR"
}

collect_config() {
	log "收集安装配置..."

	log "项目目录: $APP_DIR"
	prompt_or_env MYSQL_HOST "MySQL 主机" "$MYSQL_HOST"
	prompt_or_env MYSQL_PORT "MySQL 端口" "$MYSQL_PORT"
	prompt_or_env MYSQL_USER "MySQL 用户名" "$MYSQL_USER"
	prompt_or_env MYSQL_DATABASE "MySQL 数据库名" "$MYSQL_DATABASE"
	prompt_or_env APP_PORT "应用监听端口" "$APP_PORT"
	prompt_or_env DOMAIN "绑定域名（可留空稍后配置）" "$DOMAIN"

	# 应用数据库密码：未指定则自动生成
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

	# 1) 自动创建数据库与用户
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

	# 2) 验证连接
	test_mysql_app_connection "$MYSQL_HOST" "$MYSQL_PORT" "$MYSQL_USER" "$MYSQL_PASSWORD" \
		|| die "数据库连接失败，请检查 MySQL 服务与账号"

	# 3) 导入表结构
	import_mysql_schema "$schema" "$MYSQL_HOST" "$MYSQL_PORT" \
		"$MYSQL_USER" "$MYSQL_PASSWORD" "$MYSQL_DATABASE"
	log "数据库表结构导入完成"

	# 4) 保存凭据备查
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

main() {
	banner
	check_prerequisites
	clone_or_use_existing
	collect_config
	setup_env
	setup_mysql
	npm_build_all
	setup_supervisor

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
