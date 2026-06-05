#!/usr/bin/env bash
# Azure Panel aaPanel 部署公共函数库
# 被 install.sh / update.sh 引用

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[azure-panel]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }
err()  { echo -e "${RED}[error]${NC} $*" >&2; }
info() { echo -e "${CYAN}[info]${NC} $*"; }

die() {
	err "$1"
	exit 1
}

require_cmd() {
	command -v "$1" >/dev/null 2>&1 || die "未找到命令: $1，请先安装"
}

# aaPanel 将 Node.js 装在非标准路径，root 执行脚本时 PATH 可能找不到 npm
# 常见路径: /www/server/nvm/versions/node/v20.x.x/bin
find_aapanel_node_bin_dir() {
	local dir npm_path version

	# 用户显式指定
	if [[ -n "${NODE_BIN_DIR:-}" && -x "${NODE_BIN_DIR}/npm" ]]; then
		echo "$NODE_BIN_DIR"
		return 0
	fi

	# aaPanel NVM 目录（优先较新版本）
	if [[ -d /www/server/nvm/versions/node ]]; then
		for dir in $(ls -1 /www/server/nvm/versions/node 2>/dev/null | sort -V -r); do
			if [[ -x "/www/server/nvm/versions/node/${dir}/bin/npm" ]]; then
				echo "/www/server/nvm/versions/node/${dir}/bin"
				return 0
			fi
		done
	fi

	# 其他常见路径
	local candidates=(
		"/www/server/nodejs"
		"/usr/local/nodejs/bin"
		"/usr/local/bin"
	)
	for dir in "${candidates[@]}"; do
		if [[ -x "${dir}/npm" ]]; then
			echo "$dir"
			return 0
		fi
	done

	# 通配搜索
	for npm_path in \
		/www/server/nvm/versions/node/v*/bin/npm \
		/www/server/nodejs/v*/bin/npm \
		/root/.nvm/versions/node/v*/bin/npm; do
		[[ -x "$npm_path" ]] || continue
		echo "$(dirname "$npm_path")"
		return 0
	done

	return 1
}

# 将 aaPanel Node 路径加入 PATH，供 npm install / build 使用
setup_node_env() {
	local bin_dir=""

	if command -v npm >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
		return 0
	fi

	bin_dir="$(find_aapanel_node_bin_dir 2>/dev/null || true)"
	if [[ -n "$bin_dir" ]]; then
		export PATH="${bin_dir}:${PATH}"
		log "已加载 Node 环境: ${bin_dir} (node $(node -v 2>/dev/null), npm $(npm -v 2>/dev/null))"
		return 0
	fi

	# 尝试加载 nvm（若存在）
	if [[ -s /root/.nvm/nvm.sh ]]; then
		# shellcheck source=/dev/null
		source /root/.nvm/nvm.sh
		command -v npm >/dev/null 2>&1 && return 0
	fi

	return 1
}

require_node_tools() {
	setup_node_env || true

	if [[ -n "${NODE_BIN:-}" && -x "$NODE_BIN" ]]; then
		export PATH="$(dirname "$NODE_BIN"):${PATH}"
	fi

	command -v node >/dev/null 2>&1 || die "未找到 node。请在 aaPanel 软件商店安装 Node.js 20 LTS（Node 版本管理器）"
	command -v npm  >/dev/null 2>&1 || die "未找到 npm。请在 aaPanel 软件商店安装 Node.js 20 LTS，或设置 NODE_BIN_DIR=/path/to/node/bin"
}

find_node_bin() {
	require_node_tools
	if [[ -n "${NODE_BIN:-}" && -x "$NODE_BIN" ]]; then
		echo "$NODE_BIN"
		return
	fi
	command -v node
}

find_npm_bin() {
	require_node_tools
	command -v npm
}

find_supervisorctl() {
	if [[ -n "${SUPERVISORCTL:-}" && -x "$SUPERVISORCTL" ]]; then
		echo "$SUPERVISORCTL"
		return
	fi
	if command -v supervisorctl >/dev/null 2>&1; then
		command -v supervisorctl
		return
	fi
	if [[ -x /www/server/panel/pyenv/bin/supervisorctl ]]; then
		echo "/www/server/panel/pyenv/bin/supervisorctl"
		return
	fi
	echo ""
}

rand_hex() {
	local len="${1:-32}"
	if command -v openssl >/dev/null 2>&1; then
		openssl rand -hex "$((len / 2))"
	elif [[ -r /dev/urandom ]]; then
		head -c "$len" /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c "$len"
	else
		date +%s%N | sha256sum | head -c "$len"
	fi
}

get_env_value() {
	local key="$1"
	local file="$2"
	grep -E "^${key}=" "$file" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'"
}

read_port_from_env() {
	local env_file="$1"
	local default_port="${2:-3000}"
	local port
	port="$(get_env_value PORT "$env_file")"
	[[ -n "$port" ]] && echo "$port" || echo "$default_port"
}

write_env_file() {
	local env_file="$1"
	local mysql_host="$2"
	local mysql_port="$3"
	local mysql_user="$4"
	local mysql_password="$5"
	local mysql_database="$6"
	local secret_key="$7"
	local encryption_key="$8"
	local app_port="$9"

	cat >"$env_file" <<EOF
# Azure Panel 生产环境配置（由 install.sh 生成）
SECRET_KEY=${secret_key}
ENCRYPTION_KEY=${encryption_key}

WORKER_INTERVAL_SECONDS=60
ENABLE_EMBEDDED_WORKER=false

HOST=127.0.0.1
PORT=${app_port}

DB_DRIVER=mysql
MYSQL_HOST=${mysql_host}
MYSQL_PORT=${mysql_port}
MYSQL_USER=${mysql_user}
MYSQL_PASSWORD=${mysql_password}
MYSQL_DATABASE=${mysql_database}
EOF
}

# 尝试读取 aaPanel 保存的 MySQL root 密码
get_aapanel_mysql_root() {
	local py="" pass=""

	for py in /www/server/panel/pyenv/bin/python3 /usr/bin/python3 python3; do
		[[ -x "$py" ]] || continue
		[[ -f /www/server/panel/data/default.db ]] || continue
		pass="$("$py" - <<'PY' 2>/dev/null || true
import sqlite3
try:
    conn = sqlite3.connect('/www/server/panel/data/default.db')
    cur = conn.cursor()
    cur.execute('SELECT mysql_root FROM config WHERE id=1')
    row = cur.fetchone()
    if row and row[0]:
        print(row[0])
except Exception:
    pass
PY
)"
		[[ -n "$pass" ]] && { echo "$pass"; return 0; }
	done

	# 部分环境 root 可通过 socket 免密登录
	if mysql -uroot -e "SELECT 1" >/dev/null 2>&1; then
		echo ""
		return 0
	fi

	echo ""
	return 1
}

mysql_root_exec() {
	local sql="$1"
	local root_pass="${MYSQL_ROOT_PASSWORD:-}"

	if [[ -z "$root_pass" ]]; then
		root_pass="$(get_aapanel_mysql_root 2>/dev/null || true)"
	fi

	# socket 免密
	if mysql -uroot -e "SELECT 1" >/dev/null 2>&1; then
		mysql -uroot -e "$sql"
		return $?
	fi

	# 使用 root 密码
	if [[ -n "$root_pass" ]]; then
		MYSQL_PWD="$root_pass" mysql -uroot -h"${MYSQL_HOST:-127.0.0.1}" -P"${MYSQL_PORT:-3306}" -e "$sql"
		return $?
	fi

	return 1
}

# 自动创建数据库与用户（aaPanel 环境）
create_mysql_database_and_user() {
	local mysql_host="$1"
	local mysql_port="$2"
	local mysql_user="$3"
	local mysql_password="$4"
	local mysql_database="$5"

	require_cmd mysql
	log "创建 MySQL 数据库与用户..."

	if ! mysql_root_exec "SELECT 1" >/dev/null 2>&1; then
		if [[ "${NON_INTERACTIVE:-0}" == "1" ]]; then
			die "无法以 root 连接 MySQL，请设置 MYSQL_ROOT_PASSWORD 或先在 aaPanel 安装 MySQL"
		fi
		warn "无法自动获取 MySQL root 权限"
		read -r -s -p "请输入 MySQL root 密码: " MYSQL_ROOT_PASSWORD
		echo ""
		mysql_root_exec "SELECT 1" >/dev/null 2>&1 || die "MySQL root 连接失败，请检查密码"
	fi

	# 转义 SQL 中的单引号
	local esc_pass="${mysql_password//\'/\'\'}"

	mysql_root_exec "
CREATE DATABASE IF NOT EXISTS \`${mysql_database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${mysql_user}'@'localhost' IDENTIFIED BY '${esc_pass}';
CREATE USER IF NOT EXISTS '${mysql_user}'@'127.0.0.1' IDENTIFIED BY '${esc_pass}';
ALTER USER '${mysql_user}'@'localhost' IDENTIFIED BY '${esc_pass}';
ALTER USER '${mysql_user}'@'127.0.0.1' IDENTIFIED BY '${esc_pass}';
GRANT ALL PRIVILEGES ON \`${mysql_database}\`.* TO '${mysql_user}'@'localhost';
GRANT ALL PRIVILEGES ON \`${mysql_database}\`.* TO '${mysql_user}'@'127.0.0.1';
FLUSH PRIVILEGES;
" || die "创建数据库/用户失败"

	log "数据库已创建: ${mysql_database} | 用户: ${mysql_user}"
}

test_mysql_app_connection() {
	local mysql_host="$1"
	local mysql_port="$2"
	local mysql_user="$3"
	local mysql_password="$4"

	MYSQL_PWD="$mysql_password" mysql -h"$mysql_host" -P"$mysql_port" -u"$mysql_user" -e "SELECT 1" >/dev/null 2>&1
}

import_mysql_schema() {
	local schema_file="$1"
	local mysql_host="$2"
	local mysql_port="$3"
	local mysql_user="$4"
	local mysql_password="$5"
	local mysql_database="$6"

	require_cmd mysql
	log "导入数据库表结构: $schema_file"
	MYSQL_PWD="$mysql_password" mysql -h"$mysql_host" -P"$mysql_port" -u"$mysql_user" "$mysql_database" < <(
		sed '/^CREATE DATABASE/d; /^USE /d' "$schema_file"
	)
}

npm_build_all() {
	require_node_tools
	log "安装 npm 依赖..."
	"$(find_npm_bin)" install --production=false
	log "构建 Web + Worker..."
	"$(find_npm_bin)" run build:all
	[[ -f build/index.js ]] || die "构建失败: 未找到 build/index.js"
	[[ -f build/worker.js ]]  || die "构建失败: 未找到 build/worker.js"
	log "构建完成"
}

supervisor_conf_dir() {
	if [[ -n "${SUPERVISOR_CONF_DIR:-}" ]]; then
		echo "$SUPERVISOR_CONF_DIR"
		return
	fi
	if [[ -d /etc/supervisor/conf.d ]]; then
		echo "/etc/supervisor/conf.d"
		return
	fi
	if [[ -d /www/server/panel/plugin/supervisor/config ]]; then
		echo "/www/server/panel/plugin/supervisor/config"
		return
	fi
	echo "/etc/supervisor/conf.d"
}

write_supervisor_configs() {
	local node_bin="$1"
	local app_dir="$2"
	local app_port="$3"
	local web_program="$4"
	local worker_program="$5"
	local conf_dir
	local web_conf worker_conf

	conf_dir="$(supervisor_conf_dir)"
	mkdir -p "$conf_dir" 2>/dev/null || true

	web_conf="${conf_dir}/${web_program}.conf"
	worker_conf="${conf_dir}/${worker_program}.conf"

	log "写入 Supervisor 配置 -> $conf_dir"

	cat >"$web_conf" <<EOF
; Azure Panel Web — 由 install.sh 自动生成
[program:${web_program}]
command=${node_bin} ${app_dir}/build/index.js
directory=${app_dir}
user=www
autostart=true
autorestart=true
startsecs=5
startretries=3
stopwaitsecs=10
stdout_logfile=/www/wwwlogs/${web_program}.log
stderr_logfile=/www/wwwlogs/${web_program}-error.log
environment=NODE_ENV="production",HOST="127.0.0.1",PORT="${app_port}"
EOF

	cat >"$worker_conf" <<EOF
; Azure Panel Worker — 由 install.sh 自动生成
[program:${worker_program}]
command=${node_bin} ${app_dir}/build/worker.js
directory=${app_dir}
user=www
autostart=true
autorestart=true
startsecs=5
startretries=3
stopwaitsecs=10
stdout_logfile=/www/wwwlogs/${worker_program}.log
stderr_logfile=/www/wwwlogs/${worker_program}-error.log
environment=NODE_ENV="production"
EOF

	# 同步一份到项目目录备查
	mkdir -p "${app_dir}/deploy/aapanel/generated"
	cp "$web_conf" "${app_dir}/deploy/aapanel/generated/${web_program}.conf"
	cp "$worker_conf" "${app_dir}/deploy/aapanel/generated/${worker_program}.conf"
}

supervisor_reload_and_start() {
	local web_program="$1"
	local worker_program="$2"
	local ctl
	ctl="$(find_supervisorctl)"

	if [[ -z "$ctl" ]]; then
		warn "未找到 supervisorctl，请手动在 aaPanel Supervisor 中启动进程"
		return 1
	fi

	log "重载 Supervisor 配置..."
	$ctl reread 2>/dev/null || true
	$ctl update 2>/dev/null || true

	log "启动进程: $web_program, $worker_program"
	$ctl start "$web_program" 2>/dev/null || $ctl restart "$web_program" 2>/dev/null || warn "启动 $web_program 失败"
	$ctl start "$worker_program" 2>/dev/null || $ctl restart "$worker_program" 2>/dev/null || warn "启动 $worker_program 失败"
}

restart_supervisor_programs() {
	local web_program="$1"
	local worker_program="$2"
	local ctl
	ctl="$(find_supervisorctl)"

	if [[ -z "$ctl" ]]; then
		warn "未找到 supervisorctl，请手动在 aaPanel 重启 $web_program 和 $worker_program"
		return 1
	fi

	log "重启 Supervisor 进程: $web_program, $worker_program"
	if $ctl restart "$web_program" "$worker_program" 2>/dev/null; then
		log "Supervisor 重启成功"
	else
		$ctl restart "$web_program" || warn "重启 $web_program 失败"
		$ctl restart "$worker_program" || warn "重启 $worker_program 失败"
	fi
}

health_check() {
	local port="$1"
	log "健康检查 http://127.0.0.1:${port}/api/health ..."
	sleep 2
	if command -v curl >/dev/null 2>&1; then
		if curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null; then
			log "健康检查通过 ✓"
			return 0
		fi
		warn "健康检查未通过，请查看 /www/wwwlogs/ 下日志"
		return 1
	fi
	warn "未安装 curl，跳过健康检查"
	return 0
}

print_nginx_hint() {
	local port="$1"
	local domain="${2:-你的域名}"

	info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	info "Nginx 反代配置（aaPanel → 网站 → 配置文件）"
	info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	cat <<EOF

location / {
    proxy_pass http://127.0.0.1:${port};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
}

EOF
	info "绑定域名: ${domain}"
	info "后续升级: cd ${APP_DIR:-/www/wwwroot/azure-panel} && ./update.sh"
}

prompt_or_env() {
	# 用法: prompt_or_env VAR_NAME "提示文字" "默认值"
	local var_name="$1"
	local prompt_text="$2"
	local default_value="${3:-}"

	if [[ -n "${!var_name:-}" ]]; then
		return
	fi

	if [[ "${NON_INTERACTIVE:-0}" == "1" ]]; then
		[[ -n "$default_value" ]] && printf -v "$var_name" '%s' "$default_value"
		return
	fi

	local input
	if [[ -n "$default_value" ]]; then
		read -r -p "${prompt_text} [${default_value}]: " input
		input="${input:-$default_value}"
	else
		read -r -p "${prompt_text}: " input
	fi
	printf -v "$var_name" '%s' "$input"
}
