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

find_node_bin() {
	if [[ -n "${NODE_BIN:-}" && -x "$NODE_BIN" ]]; then
		echo "$NODE_BIN"
		return
	fi
	command -v node 2>/dev/null || die "未找到 node，请在 aaPanel 安装 Node.js 20 LTS"
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

import_mysql_schema() {
	local schema_file="$1"
	local mysql_host="$2"
	local mysql_port="$3"
	local mysql_user="$4"
	local mysql_password="$5"

	require_cmd mysql
	log "导入数据库结构: $schema_file"
	MYSQL_PWD="$mysql_password" mysql -h"$mysql_host" -P"$mysql_port" -u"$mysql_user" <"$schema_file"
}

npm_build_all() {
	log "安装 npm 依赖..."
	npm install --production=false
	log "构建 Web + Worker..."
	npm run build:all
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
