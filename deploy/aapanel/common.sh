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
	if [[ -x /www/server/panel/pyenv/bin/supervisorctl ]]; then
		echo "/www/server/panel/pyenv/bin/supervisorctl"
		return
	fi
	if command -v supervisorctl >/dev/null 2>&1; then
		command -v supervisorctl
		return
	fi
	echo ""
}

find_supervisor_main_conf() {
	local f
	for f in \
		/www/server/panel/plugin/supervisor/supervisord.conf \
		/www/server/panel/plugin/supervisor/supervisor.conf \
		/etc/supervisor/supervisord.conf; do
		[[ -f "$f" ]] && { echo "$f"; return 0; }
	done
	return 1
}

run_supervisorctl() {
	local ctl main_conf
	ctl="$(find_supervisorctl)"
	[[ -n "$ctl" ]] || return 127
	main_conf="$(find_supervisor_main_conf 2>/dev/null || true)"
	if [[ -n "$main_conf" ]]; then
		"$ctl" -c "$main_conf" "$@"
	else
		"$ctl" "$@"
	fi
}

supervisor_conf_dirs() {
	local dir seen=()
	if [[ -n "${SUPERVISOR_CONF_DIR:-}" ]]; then
		seen+=("$SUPERVISOR_CONF_DIR")
	fi
	for dir in \
		/www/server/panel/plugin/supervisor/profile \
		/www/server/panel/plugin/supervisor/config \
		/etc/supervisor/conf.d; do
		[[ -d "$dir" ]] || continue
		local dup=0 d
		for d in "${seen[@]}"; do [[ "$d" == "$dir" ]] && dup=1 && break; done
		[[ "$dup" == "0" ]] && seen+=("$dir")
	done
	if [[ ${#seen[@]} -eq 0 ]]; then
		seen+=("/etc/supervisor/conf.d")
	fi
	printf '%s\n' "${seen[@]}"
}

restart_supervisord_service() {
	log "尝试重启 Supervisor 服务..."
	if [[ -x /etc/init.d/supervisord ]]; then
		/etc/init.d/supervisord restart 2>/dev/null && return 0
	fi
	if [[ -x /etc/init.d/supervisor ]]; then
		/etc/init.d/supervisor restart 2>/dev/null && return 0
	fi
	systemctl restart supervisord 2>/dev/null && return 0
	systemctl restart supervisor 2>/dev/null && return 0
	run_supervisorctl reload 2>/dev/null && return 0
	return 1
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
	local line name value first last
	[[ -f "$file" ]] || return 0

	while IFS= read -r line || [[ -n "$line" ]]; do
		line="${line%$'\r'}"
		line="${line#"${line%%[![:space:]]*}"}"
		line="${line%"${line##*[![:space:]]}"}"
		[[ -z "$line" || "$line" == \#* ]] && continue

		if [[ "$line" =~ ^export[[:space:]]+(.+)$ ]]; then
			line="${BASH_REMATCH[1]}"
		fi

		if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
			name="${BASH_REMATCH[1]}"
			[[ "$name" == "$key" ]] || continue

			value="${BASH_REMATCH[2]}"
			value="${value#"${value%%[![:space:]]*}"}"
			value="${value%"${value##*[![:space:]]}"}"
			first="${value:0:1}"
			last="${value: -1}"
			if [[ ${#value} -ge 2 && ( ( "$first" == '"' && "$last" == '"' ) || ( "$first" == "'" && "$last" == "'" ) ) ]]; then
				value="${value:1:${#value}-2}"
			fi
			printf '%s\n' "$value"
		fi
	done <"$file" | tail -1
}

env_uses_mysql() {
	local env_file="$1"
	local db_driver mysql_host database_url
	db_driver="$(get_env_value DB_DRIVER "$env_file" | tr '[:upper:]' '[:lower:]')"
	mysql_host="$(get_env_value MYSQL_HOST "$env_file")"
	database_url="$(get_env_value DATABASE_URL "$env_file")"
	[[ "$db_driver" == "mysql" || -n "$mysql_host" || "$database_url" == mysql* ]]
}

fix_env_file_permissions() {
	local env_file="$1"
	[[ -f "$env_file" ]] || return 0

	if id -u www >/dev/null 2>&1; then
		chown root:www "$env_file" 2>/dev/null || chgrp www "$env_file" 2>/dev/null || true
		chmod 640 "$env_file" 2>/dev/null || true
	else
		chmod 600 "$env_file" 2>/dev/null || true
	fi
}

ensure_runtime_env_defaults() {
	local env_file="${1:-.env}"
	[[ -f "$env_file" ]] || return 0

	if ! grep -q '^ENABLE_EMBEDDED_WORKER=' "$env_file" 2>/dev/null; then
		printf '\n# Runtime memory guard: use the standalone worker process in production.\nENABLE_EMBEDDED_WORKER=false\n' >>"$env_file"
		log "Added ENABLE_EMBEDDED_WORKER=false to $env_file"
	fi
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
	local MYSQL_HOST="$mysql_host"
	local MYSQL_PORT="$mysql_port"

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

register_aapanel_database_record() {
	local mysql_host="$1"
	local mysql_port="$2"
	local mysql_user="$3"
	local mysql_password="$4"
	local mysql_database="$5"
	local remark="${6:-Azure Panel}"
	local panel_db="/www/server/panel/data/default.db"
	local panel_py=""

	[[ "${REGISTER_AAPANEL_DB:-1}" == "0" ]] && return 0
	[[ -f "$panel_db" ]] || return 0

	for panel_py in /www/server/panel/pyenv/bin/python3 /usr/bin/python3 python3; do
		if [[ -x "$panel_py" ]] || command -v "$panel_py" >/dev/null 2>&1; then
			break
		fi
		panel_py=""
	done
	[[ -n "$panel_py" ]] || { warn "Python not found; skip aaPanel database list sync"; return 0; }

	log "同步 aaPanel 数据库列表记录: ${mysql_database}"
	AAPANEL_DB_NAME="$mysql_database" \
	AAPANEL_DB_USER="$mysql_user" \
	AAPANEL_DB_PASSWORD="$mysql_password" \
	AAPANEL_DB_HOST="$mysql_host" \
	AAPANEL_DB_PORT="$mysql_port" \
	AAPANEL_DB_REMARK="$remark" \
	"$panel_py" - <<'PY' || true
import os
import sqlite3
import time

panel_db = "/www/server/panel/data/default.db"
name = os.environ.get("AAPANEL_DB_NAME", "")
user = os.environ.get("AAPANEL_DB_USER", "")
password = os.environ.get("AAPANEL_DB_PASSWORD", "")
host = os.environ.get("AAPANEL_DB_HOST", "127.0.0.1")
port = os.environ.get("AAPANEL_DB_PORT", "3306")
remark = os.environ.get("AAPANEL_DB_REMARK", "Azure Panel")
accept = "127.0.0.1" if host in ("127.0.0.1", "localhost", "::1") else host
display_host = "Localhost" if host in ("127.0.0.1", "localhost", "::1") else host

def default_for(column_type):
    t = (column_type or "").lower()
    if any(k in t for k in ("int", "real", "numeric", "double", "float")):
        return 0
    return ""

def table_exists(cur, table_name):
    return cur.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (table_name,),
    ).fetchone() is not None

def table_columns(cur, table_name):
    if not table_exists(cur, table_name):
        return []
    return [row["name"] for row in cur.execute(f"PRAGMA table_info(`{table_name}`)").fetchall()]

def first_column(columns, candidates):
    for column in candidates:
        if column in columns:
            return column
    return ""

def normalize_host(value):
    value = str(value or "").strip().lower()
    if value in ("127.0.0.1", "localhost", "::1", "local", "localhost/mysql"):
        return "local"
    return value

def detect_local_database_server_id(cur):
    columns = table_columns(cur, "database_servers")
    if not columns or "id" not in columns:
        return 0

    host_col = first_column(columns, ("db_host", "host", "address", "server", "ip"))
    port_col = first_column(columns, ("db_port", "port"))
    name_col = first_column(columns, ("name", "title", "ps"))
    type_col = first_column(columns, ("db_type", "type", "dtype"))
    rows = cur.execute("SELECT * FROM database_servers").fetchall()
    desired_host = normalize_host(host)
    desired_port = str(port or "3306")

    best_id = 0
    best_score = -1
    for item in rows:
        score = 0
        item_host = normalize_host(item[host_col]) if host_col else ""
        item_port = str(item[port_col] or "") if port_col else ""
        item_name = str(item[name_col] or "").lower() if name_col else ""
        item_type = str(item[type_col] or "").lower() if type_col else ""

        if item_host == desired_host:
            score += 4
        elif desired_host == "local" and (not item_host or "local" in item_name):
            score += 2

        if item_port == desired_port:
            score += 2
        elif not item_port:
            score += 1

        if item_type in ("0", "mysql", "mariadb", ""):
            score += 1
        if "local" in item_name or "localhost" in item_name:
            score += 1

        if score > best_score:
            best_score = score
            best_id = int(item["id"] or 0)

    return best_id if best_score >= 2 else 0

known_values = {
    "name": name,
    "username": user,
    "password": password,
    "accept": accept,
    "address": display_host,
    "dataAccess": display_host,
    "ps": remark,
    "addtime": time.strftime("%Y-%m-%d %H:%M:%S"),
    "pid": 0,
    "sid": 0,
    "backup_count": 0,
    # aaPanel backup code uses numeric db_type: 0=local MySQL, 1=external DB, 2=remote server.
    # Writing "MySQL" here makes backups fail with "unknow database type".
    "db_type": 0,
    "type": "MySQL",
    "dtype": "MySQL",
    "codeing": "utf8mb4",
    "ssl": "",
    "host": display_host,
    "db_host": host,
    "port": port,
    "db_port": port,
}

try:
    conn = sqlite3.connect(panel_db)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    if not table_exists(cur, "databases"):
        print("[aapanel-db] table 'databases' not found; skip")
        raise SystemExit(0)

    local_sid = detect_local_database_server_id(cur)
    if local_sid:
        known_values["sid"] = local_sid

    columns = cur.execute("PRAGMA table_info(databases)").fetchall()
    column_names = [row["name"] for row in columns]
    if "name" not in column_names:
        print("[aapanel-db] column 'name' not found; skip")
        raise SystemExit(0)

    row = cur.execute("SELECT * FROM databases WHERE name=?", (name,)).fetchone()
    values = {}
    for column in columns:
        col = column["name"]
        if column["pk"]:
            continue
        if col in known_values:
            values[col] = known_values[col]
        elif row is None and column["notnull"] and column["dflt_value"] is None:
            values[col] = default_for(column["type"])

    if row is None:
        cols = list(values)
        placeholders = ",".join(["?"] * len(cols))
        quoted = ",".join([f"`{col}`" for col in cols])
        cur.execute(
            f"INSERT INTO databases ({quoted}) VALUES ({placeholders})",
            [values[col] for col in cols],
        )
        print(f"[aapanel-db] inserted panel record for {name}")
    else:
        update_cols = [col for col in values if col not in ("name", "addtime")]
        if update_cols:
            set_clause = ",".join([f"`{col}`=?" for col in update_cols])
            cur.execute(
                f"UPDATE databases SET {set_clause} WHERE name=?",
                [values[col] for col in update_cols] + [name],
            )
        print(f"[aapanel-db] updated panel record for {name}")

    conn.commit()
except Exception as exc:
    print(f"[aapanel-db] sync failed: {exc}")
PY
}

test_mysql_app_connection() {
	local mysql_host="$1"
	local mysql_port="$2"
	local mysql_user="$3"
	local mysql_password="$4"
	local mysql_database="${5:-}"

	if [[ -n "$mysql_database" ]]; then
		MYSQL_PWD="$mysql_password" mysql -h"$mysql_host" -P"$mysql_port" -u"$mysql_user" "$mysql_database" -e "SELECT 1" >/dev/null 2>&1
	else
		MYSQL_PWD="$mysql_password" mysql -h"$mysql_host" -P"$mysql_port" -u"$mysql_user" -e "SELECT 1" >/dev/null 2>&1
	fi
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

repair_mysql_from_env() {
	local env_file="${1:-.env}"
	local app_dir="${2:-$(pwd)}"
	local schema="${app_dir}/deploy/aapanel/schema.mysql.sql"
	local mysql_host mysql_port mysql_user mysql_password mysql_database

	env_uses_mysql "$env_file" || return 0

	mysql_host="$(get_env_value MYSQL_HOST "$env_file")"
	mysql_port="$(get_env_value MYSQL_PORT "$env_file")"
	mysql_user="$(get_env_value MYSQL_USER "$env_file")"
	mysql_password="$(get_env_value MYSQL_PASSWORD "$env_file")"
	mysql_database="$(get_env_value MYSQL_DATABASE "$env_file")"

	mysql_host="${mysql_host:-127.0.0.1}"
	mysql_port="${mysql_port:-3306}"
	mysql_user="${mysql_user:-azure_panel}"
	mysql_database="${mysql_database:-azure_panel}"

	if [[ -z "$mysql_password" || "$mysql_password" == "your-mysql-password" ]]; then
		warn "MySQL 密码为空或仍是占位值，请先运行 install.sh 生成真实 .env，或手动填写 MYSQL_PASSWORD"
		return 1
	fi

	if ! command -v mysql >/dev/null 2>&1; then
		warn "未找到 mysql 客户端，跳过 MySQL 自检/补建；请在 aaPanel 安装 MySQL"
		return 1
	fi

	log "检查 MySQL 数据库连接: ${mysql_database} (${mysql_user}@${mysql_host}:${mysql_port})"
	if ! test_mysql_app_connection "$mysql_host" "$mysql_port" "$mysql_user" "$mysql_password" "$mysql_database"; then
		warn "应用数据库连接失败，尝试自动创建/修复数据库与用户"
		create_mysql_database_and_user "$mysql_host" "$mysql_port" "$mysql_user" "$mysql_password" "$mysql_database"
	fi

	test_mysql_app_connection "$mysql_host" "$mysql_port" "$mysql_user" "$mysql_password" "$mysql_database" \
		|| { warn "MySQL 连接仍失败，请检查 .env 中 MYSQL_* 配置"; return 1; }

	if [[ -f "$schema" ]]; then
		import_mysql_schema "$schema" "$mysql_host" "$mysql_port" "$mysql_user" "$mysql_password" "$mysql_database"
		log "MySQL 表结构已确认"
	else
		warn "未找到 schema 文件，跳过表结构导入: $schema"
	fi

	register_aapanel_database_record \
		"$mysql_host" "$mysql_port" "$mysql_user" "$mysql_password" "$mysql_database" \
		"${DOMAIN:-Azure Panel}"
}

npm_install_with_registry() {
	local npm_bin="$1"
	local registry="$2"
	"$npm_bin" install --include=dev --registry="$registry"
}

node_memory_options() {
	echo "${NODE_OPTIONS:---max-old-space-size=${NODE_MAX_OLD_SPACE_SIZE:-192}}"
}

prune_production_dependencies() {
	local npm_bin="$1"
	if [[ "${SKIP_NPM_PRUNE:-0}" == "1" ]]; then
		warn "已跳过 npm production 裁剪 (SKIP_NPM_PRUNE=1)"
		return 0
	fi
	log "裁剪生产依赖，移除 devDependencies..."
	NODE_ENV=production "$npm_bin" prune --omit=dev --no-audit --no-fund >/dev/null 2>&1 \
		&& log "生产依赖裁剪完成" \
		|| warn "npm prune 失败，保留现有 node_modules"
}

post_deploy_cleanup() {
	local app_dir="${1:-$(pwd)}"
	local npm_bin="${2:-}"
	local target

	if [[ "${SKIP_DEPLOY_CLEANUP:-0}" == "1" ]]; then
		warn "已跳过升级后清理 (SKIP_DEPLOY_CLEANUP=1)"
		return 0
	fi

	log "清理升级/构建临时文件，降低磁盘与内存压力..."
	for target in \
		"${app_dir}/.svelte-kit" \
		"${app_dir}/deploy/aapanel/generated/proxy-core-download" \
		"${app_dir}/node_modules/.cache"; do
		[[ -e "$target" ]] || continue
		rm -rf "$target" 2>/dev/null || warn "清理失败: $target"
	done

	if [[ -n "$npm_bin" ]]; then
		"$npm_bin" cache clean --force >/dev/null 2>&1 || true
	fi

	if [[ "${SKIP_DROP_CACHES:-0}" != "1" && -w /proc/sys/vm/drop_caches ]]; then
		sync 2>/dev/null || true
		echo 3 >/proc/sys/vm/drop_caches 2>/dev/null || true
		log "已请求系统释放文件缓存"
	fi
}

list_project_runtime_pids() {
	local app_dir="${1:-$(pwd)}"
	local pattern="$2"
	local pid cmd
	[[ -r /proc ]] || return 0
	for proc in /proc/[0-9]*; do
		pid="${proc##*/}"
		[[ "$pid" == "$$" ]] && continue
		[[ -r "$proc/cmdline" ]] || continue
		cmd="$(tr '\0' ' ' <"$proc/cmdline" 2>/dev/null || true)"
		[[ -n "$cmd" ]] || continue
		[[ "$cmd" == *"${app_dir}/${pattern}"* ]] && echo "$pid"
	done
}

terminate_pids() {
	local reason="$1"
	shift || true
	local -a pids=("$@")
	[[ ${#pids[@]} -gt 0 ]] || return 0

	log "Runtime memory cleanup: stopping ${reason} PID=${pids[*]}"
	kill -TERM "${pids[@]}" 2>/dev/null || true
	sleep 2

	local -a alive=()
	local pid
	for pid in "${pids[@]}"; do
		[[ -d "/proc/$pid" ]] && alive+=("$pid")
	done
	if [[ ${#alive[@]} -gt 0 ]]; then
		warn "${reason} still alive, force killing PID=${alive[*]}"
		kill -KILL "${alive[@]}" 2>/dev/null || true
	fi
}

cleanup_project_node_runtimes() {
	local app_dir="${1:-$(pwd)}"
	local -a pids=()
	mapfile -t pids < <(
		{
			list_project_runtime_pids "$app_dir" "build/index.js"
			list_project_runtime_pids "$app_dir" "build/worker.js"
		} | sort -n -u
	)
	terminate_pids "old Web/Worker Node" "${pids[@]}"
}

cleanup_managed_proxy_runtimes() {
	local app_dir="${1:-$(pwd)}"
	local managed_dir="${MANAGED_PROXY_DIR:-${app_dir}/data/managed-proxies}"
	local pid cmd
	local -a pids=()
	[[ -r /proc ]] || return 0

	for proc in /proc/[0-9]*; do
		pid="${proc##*/}"
		[[ "$pid" == "$$" ]] && continue
		[[ -r "$proc/cmdline" ]] || continue
		cmd="$(tr '\0' ' ' <"$proc/cmdline" 2>/dev/null || true)"
		[[ -n "$cmd" ]] || continue
		if [[ "$cmd" == *"${app_dir}/bin/sing-box"* && "$cmd" == *" ${managed_dir}/"* ]]; then
			pids+=("$pid")
		elif [[ "$cmd" == *"${app_dir}/bin/xray"* && "$cmd" == *" ${managed_dir}/"* ]]; then
			pids+=("$pid")
		fi
	done

	if [[ ${#pids[@]} -gt 0 ]]; then
		mapfile -t pids < <(printf '%s\n' "${pids[@]}" | sort -n -u)
		terminate_pids "old managed proxy core" "${pids[@]}"
	fi
}

runtime_memory_cleanup_before_restart() {
	local app_dir="${1:-$(pwd)}"
	if [[ "${SKIP_RUNTIME_CLEANUP:-0}" == "1" ]]; then
		warn "Skipped runtime process cleanup (SKIP_RUNTIME_CLEANUP=1)"
		return 0
	fi
	cleanup_managed_proxy_runtimes "$app_dir"
	cleanup_project_node_runtimes "$app_dir"
}

npm_build_all() {
	require_node_tools
	local npm_bin
	local registry
	local -a registries=()

	npm_bin="$(find_npm_bin)"

	# 优先项目 .npmrc，其次环境变量，最后官方源（避免 aaPanel 全局 npmmirror 缺包）
	if [[ -f .npmrc ]] && grep -q '^registry=' .npmrc 2>/dev/null; then
		registry="$(grep '^registry=' .npmrc | tail -1 | cut -d= -f2- | tr -d ' ')"
		registries+=("$registry")
	fi
	[[ -n "${NPM_REGISTRY:-}" ]] && registries+=("$NPM_REGISTRY")
	registries+=("https://registry.npmjs.org" "https://registry.npmmirror.com")

	log "安装 npm 依赖..."
	local tried=()
	for registry in "${registries[@]}"; do
		[[ -z "$registry" ]] && continue
		# 去重
		local skip=0 r
		for r in "${tried[@]}"; do [[ "$r" == "$registry" ]] && skip=1 && break; done
		[[ "$skip" == "1" ]] && continue
		tried+=("$registry")

		log "尝试 npm 源: $registry"
		if npm_install_with_registry "$npm_bin" "$registry"; then
			log "npm 依赖安装成功"
			break
		fi
		warn "源 $registry 安装失败，尝试下一个..."
	done

	[[ -d node_modules ]] || die "npm install 失败。请手动执行: NPM_REGISTRY=https://registry.npmjs.org npm install"

	log "同步 SvelteKit 配置..."
	"$npm_bin" exec svelte-kit sync 2>/dev/null || true

	log "构建 Web + Worker..."
	"$npm_bin" run build:all
	[[ -f build/index.js ]] || die "构建失败: 未找到 build/index.js"
	[[ -f build/worker.js ]]  || die "构建失败: 未找到 build/worker.js"
	log "构建完成"

	prune_production_dependencies "$npm_bin"
	post_deploy_cleanup "$(pwd)" "$npm_bin"
}

detect_arch_label() {
	local machine
	machine="$(uname -m 2>/dev/null || echo unknown)"
	case "$machine" in
		x86_64|amd64) echo "amd64" ;;
		aarch64|arm64) echo "arm64" ;;
		*) echo "" ;;
	esac
}

detect_xray_arch_label() {
	local machine
	machine="$(uname -m 2>/dev/null || echo unknown)"
	case "$machine" in
		x86_64|amd64) echo "64" ;;
		aarch64|arm64) echo "arm64-v8a" ;;
		*) echo "" ;;
	esac
}

download_file() {
	local url="$1"
	local dest="$2"
	if command -v curl >/dev/null 2>&1; then
		curl -fL --retry 2 --connect-timeout 10 "$url" -o "$dest"
	elif command -v wget >/dev/null 2>&1; then
		wget -O "$dest" "$url"
	else
		return 1
	fi
}

latest_github_version() {
	local repo="$1"
	local fallback="$2"
	local url="https://api.github.com/repos/${repo}/releases/latest"
	local tag=""

	if command -v curl >/dev/null 2>&1; then
		tag="$(curl -fsSL --connect-timeout 8 "$url" 2>/dev/null | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
	fi
	tag="${tag#v}"
	echo "${tag:-$fallback}"
}

ensure_proxy_cores() {
	if [[ "${SKIP_PROXY_CORE_INSTALL:-0}" == "1" ]]; then
		warn "已跳过内置代理核心安装 (SKIP_PROXY_CORE_INSTALL=1)"
		return 0
	fi
	if [[ "$(uname -s 2>/dev/null)" != "Linux" ]]; then
		warn "当前系统不是 Linux，跳过 sing-box/Xray 自动下载；可通过 SING_BOX_BIN 或 XRAY_BIN 指定核心路径"
		return 0
	fi

	local arch xray_arch bin_dir tmp_dir sing_ver xray_ver sing_url xray_url
	arch="$(detect_arch_label)"
	if [[ -z "$arch" ]]; then
		warn "未识别 CPU 架构，跳过 sing-box/Xray 自动下载"
		return 0
	fi
	xray_arch="$(detect_xray_arch_label)"

	bin_dir="${APP_DIR:-$(pwd)}/bin"
	tmp_dir="${APP_DIR:-$(pwd)}/deploy/aapanel/generated/proxy-core-download"
	mkdir -p "$bin_dir" "$tmp_dir"

	if [[ ! -x "${bin_dir}/sing-box" ]]; then
		sing_ver="${SING_BOX_VERSION:-$(latest_github_version SagerNet/sing-box 1.12.0)}"
		sing_url="https://github.com/SagerNet/sing-box/releases/download/v${sing_ver}/sing-box-${sing_ver}-linux-${arch}.tar.gz"
		log "下载 sing-box ${sing_ver} (${arch})..."
		if download_file "$sing_url" "${tmp_dir}/sing-box.tar.gz"; then
			if command -v tar >/dev/null 2>&1 && tar -xzf "${tmp_dir}/sing-box.tar.gz" -C "$tmp_dir"; then
				find "$tmp_dir" -type f -name sing-box -perm /111 -exec cp {} "${bin_dir}/sing-box" \; -quit
				chmod +x "${bin_dir}/sing-box" 2>/dev/null || true
				[[ -x "${bin_dir}/sing-box" ]] && log "sing-box 已安装: ${bin_dir}/sing-box" || warn "sing-box 解压后未找到可执行文件"
			else
				warn "sing-box 解压失败，可手动设置 SING_BOX_BIN=/path/to/sing-box"
			fi
		else
			warn "sing-box 下载失败，可手动设置 SING_BOX_BIN=/path/to/sing-box"
		fi
	else
		log "sing-box 已存在: ${bin_dir}/sing-box"
	fi

	if [[ ! -x "${bin_dir}/xray" ]]; then
		if [[ -z "$xray_arch" ]]; then
			warn "未识别 Xray CPU 架构，跳过 Xray 自动下载"
			return 0
		fi
		local xray_urls=()
		xray_ver="${XRAY_VERSION:-$(latest_github_version XTLS/Xray-core 25.4.30)}"
		xray_urls+=("https://github.com/XTLS/Xray-core/releases/download/v${xray_ver}/Xray-linux-${xray_arch}.zip")
		xray_urls+=("https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-${xray_arch}.zip")
		[[ "$xray_ver" == "25.4.30" ]] || xray_urls+=("https://github.com/XTLS/Xray-core/releases/download/v25.4.30/Xray-linux-${xray_arch}.zip")
		log "下载 Xray ${xray_ver} (${xray_arch})..."
		local xray_downloaded=0
		for xray_url in "${xray_urls[@]}"; do
			if download_file "$xray_url" "${tmp_dir}/xray.zip"; then
				xray_downloaded=1
				break
			fi
			warn "Xray 下载失败: $xray_url"
		done
		if [[ "$xray_downloaded" == "1" ]]; then
			if command -v unzip >/dev/null 2>&1; then
				unzip -o "${tmp_dir}/xray.zip" -d "${tmp_dir}/xray" >/dev/null
				find "${tmp_dir}/xray" -type f -name xray -perm /111 -exec cp {} "${bin_dir}/xray" \; -quit
				chmod +x "${bin_dir}/xray" 2>/dev/null || true
				[[ -x "${bin_dir}/xray" ]] && log "Xray 已安装: ${bin_dir}/xray" || warn "Xray 解压后未找到可执行文件"
			else
				warn "未安装 unzip，跳过 Xray 解压；如需 Xray 请安装 unzip 后重跑 update.sh"
			fi
		else
			warn "Xray 下载失败，可手动设置 XRAY_BIN=/path/to/xray"
		fi
	else
		log "Xray 已存在: ${bin_dir}/xray"
	fi
}

supervisor_conf_dir() {
	supervisor_conf_dirs | head -1
}

detect_nodejs_version_label() {
	local bin_dir version

	bin_dir="$(find_aapanel_node_bin_dir 2>/dev/null || true)"
	if [[ -n "$bin_dir" ]]; then
		version="$(echo "$bin_dir" | sed -n 's|.*/versions/node/\(v[^/]*\)/bin|\1|p')"
		[[ -n "$version" ]] && { echo "$version"; return 0; }
	fi
	echo "${NODEJS_VERSION:-v20.20.2}"
}

# 注册 aaPanel 站点前停止 Supervisor，避免与面板 Node 项目争抢端口
release_app_port() {
	local port="$1"
	local web_program="$2"
	local worker_program="$3"

	if [[ -n "$(find_supervisorctl)" ]]; then
		log "停止 Supervisor 进程..."
		run_supervisorctl stop "$web_program" "$worker_program" 2>/dev/null || true
		sleep 1
	fi
}

is_app_healthy() {
	local port="$1"
	command -v curl >/dev/null 2>&1 && curl -fsS --connect-timeout 3 --max-time 8 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1
}

aapanel_project_exists() {
	local name="$1"
	local panel_py="/www/server/panel/pyenv/bin/python3"

	[[ -d /www/server/panel && -x "$panel_py" ]] || return 1
	"$panel_py" - <<PY >/dev/null 2>&1
import sys
sys.path.insert(0, "/www/server/panel/class")
import public
sys.exit(0 if public.M("sites").where("name=?", ("${name}",)).count() > 0 else 1)
PY
}

# 在 aaPanel 面板中注册 Web（Node 项目）与 Worker（通用项目），便于网站列表统一管理
setup_aapanel_site() {
	local app_dir="$1"
	local domain="$2"
	local port="$3"
	local web_project_name="${4:-Azure-Panel}"
	local py_script panel_py node_version

	if [[ -z "$domain" ]]; then
		warn "未设置 DOMAIN，跳过 aaPanel 站点注册"
		return 1
	fi

	if [[ "${SKIP_AAPANEL_SITE:-0}" == "1" ]]; then
		warn "已跳过 aaPanel 站点注册 (SKIP_AAPANEL_SITE=1)"
		return 1
	fi

	if [[ ! -d /www/server/panel ]]; then
		warn "未检测到 aaPanel 安装目录，跳过站点注册"
		return 1
	fi

	py_script="${app_dir}/deploy/aapanel/register-aapanel-site.py"
	[[ -f "$py_script" ]] || { warn "未找到 $py_script"; return 1; }

	panel_py="/www/server/panel/pyenv/bin/python3"
	[[ -x "$panel_py" ]] || panel_py="$(command -v python3 2>/dev/null || true)"
	[[ -n "$panel_py" ]] || { warn "未找到 python3，无法调用 aaPanel API"; return 1; }

	node_version="$(detect_nodejs_version_label)"
	log "注册 aaPanel 站点: ${domain} (Node ${node_version})"

	release_app_port "$port" "${WEB_PROGRAM:-azure-panel-web}" "${WORKER_PROGRAM:-azure-panel-worker}"

	chmod +x "$py_script" 2>/dev/null || true
	if NODEJS_VERSION="$node_version" \
		WORKER_PROJECT_NAME="${WORKER_PROGRAM:-azure-panel-worker}" \
		"$panel_py" "$py_script" "$app_dir" "$domain" "$port" "$web_project_name"; then
		mkdir -p "${app_dir}/deploy/aapanel/generated"
		cat >"${app_dir}/deploy/aapanel/generated/aapanel-site.txt" <<EOF
# aaPanel 站点信息（install.sh 自动生成）
DOMAIN=${domain}
WEB_PROJECT=${web_project_name}
WORKER_PROJECT=${WORKER_PROGRAM:-azure-panel-worker}
PORT=${port}
EOF
		log "aaPanel 站点注册成功 — 请在「网站 → Node 项目」中查看与管理"
		return 0
	fi

	warn "aaPanel 站点注册失败，将回退 Supervisor 启动"
	return 1
}

restart_aapanel_node_projects() {
	local web_name="${1:-Azure-Panel}"
	local worker_name="${2:-azure-panel-worker}"
	local panel_py="/www/server/panel/pyenv/bin/python3"

	[[ -d /www/server/panel ]] || return 1
	[[ -x "$panel_py" ]] || return 1

	log "通过 aaPanel 重启 Node 项目: $web_name, $worker_name"
	"$panel_py" - <<PY
import sys
sys.path.insert(0, "/www/server/panel/class")
sys.path.insert(0, "/www/server/panel")
import os
os.chdir("/www/server/panel")
import public
from mod.project.nodejs import nodeMod, generalMod

restarted = 0
SUCCESS_HINTS = ("成功", "success", "Success", "started", "Started")

def ok(res):
    if isinstance(res, dict):
        st = res.get("status")
        if st is True or st in (0, "0"):
            return True
        for k in ("msg", "message", "result", "data"):
            v = res.get(k)
            if isinstance(v, str) and any(h in v for h in SUCCESS_HINTS):
                return True
    return bool(res)

for name, mod in [("${web_name}", nodeMod), ("${worker_name}", generalMod)]:
    if public.M("sites").where("name=?", (name,)).count() == 0:
        continue
    get = public.dict_obj()
    get.project_name = name
    try:
        mod.main().stop_project(get)
    except Exception:
        pass
    try:
        res = mod.main().restart_project(get)
        print("[aapanel] restart {} -> {}".format(name, res))
        if ok(res):
            restarted += 1
    except Exception as exc:
        print("[aapanel] restart {} failed: {}".format(name, exc))
        sys.exit(1)
sys.exit(0 if restarted > 0 else 1)
PY
}

write_supervisor_configs() {
	local node_bin="$1"
	local app_dir="$2"
	local app_port="$3"
	local web_program="$4"
	local worker_program="$5"
	local conf_dir web_conf worker_conf web_body worker_body node_opts

	node_opts="$(node_memory_options)"

	web_body="; Azure Panel Web — 由 install.sh 自动生成
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
environment=NODE_ENV=\"production\",ENABLE_EMBEDDED_WORKER=\"false\",NODE_OPTIONS=\"${node_opts}\",HOST=\"127.0.0.1\",PORT=\"${app_port}\""

	worker_body="; Azure Panel Worker — 由 install.sh 自动生成
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
environment=NODE_ENV=\"production\",ENABLE_EMBEDDED_WORKER=\"false\",NODE_OPTIONS=\"${node_opts}\""

	mkdir -p /www/wwwlogs 2>/dev/null || true
	mkdir -p "${app_dir}/deploy/aapanel/generated"

	while IFS= read -r conf_dir; do
		[[ -n "$conf_dir" ]] || continue
		mkdir -p "$conf_dir" 2>/dev/null || continue

		# aaPanel profile 目录常用 .ini 后缀
		if [[ "$conf_dir" == *"/profile" ]]; then
			web_conf="${conf_dir}/${web_program}.ini"
			worker_conf="${conf_dir}/${worker_program}.ini"
		else
			web_conf="${conf_dir}/${web_program}.conf"
			worker_conf="${conf_dir}/${worker_program}.conf"
		fi

		log "写入 Supervisor 配置 -> $conf_dir"
		if [[ "${SKIP_SUPERVISOR_WEB:-0}" != "1" ]]; then
			printf '%s\n' "$web_body" >"$web_conf"
		fi
		if [[ "${SKIP_SUPERVISOR_WORKER:-0}" != "1" ]]; then
			printf '%s\n' "$worker_body" >"$worker_conf"
		fi
	done < <(supervisor_conf_dirs)

	mkdir -p "${app_dir}/deploy/aapanel/generated"
	if [[ "${SKIP_SUPERVISOR_WEB:-0}" != "1" ]]; then
		printf '%s\n' "$web_body" >"${app_dir}/deploy/aapanel/generated/${web_program}.conf"
	fi
	if [[ "${SKIP_SUPERVISOR_WORKER:-0}" != "1" ]]; then
		printf '%s\n' "$worker_body" >"${app_dir}/deploy/aapanel/generated/${worker_program}.conf"
	fi
}

supervisor_reload_and_start() {
	local web_program="$1"
	local worker_program="$2"
	local main_conf update_out

	if [[ -z "$(find_supervisorctl)" ]]; then
		warn "未找到 supervisorctl，请手动在 aaPanel Supervisor 中启动进程"
		return 1
	fi

	main_conf="$(find_supervisor_main_conf 2>/dev/null || true)"
	[[ -n "$main_conf" ]] && log "Supervisor 主配置: $main_conf"

	log "重载 Supervisor 配置..."
	run_supervisorctl reread 2>&1 || true
	update_out="$(run_supervisorctl update 2>&1 || true)"
	log "$update_out"

	if echo "$update_out" | grep -qi "no config updates"; then
		warn "Supervisor 未加载新配置，尝试重启 supervisord..."
		restart_supervisord_service || true
		run_supervisorctl reread 2>&1 || true
		update_out="$(run_supervisorctl update 2>&1 || true)"
		log "$update_out"
	fi

	local -a progs=()
	[[ "${SKIP_SUPERVISOR_WEB:-0}" != "1" ]] && progs+=("$web_program")
	[[ "${SKIP_SUPERVISOR_WORKER:-0}" != "1" ]] && progs+=("$worker_program")

	if [[ ${#progs[@]} -eq 0 ]]; then
		warn "无 Supervisor 进程需启动（已由 aaPanel Node 项目管理）"
		return 0
	fi

	log "启动进程: ${progs[*]}"
	for prog in "${progs[@]}"; do
		if run_supervisorctl status "$prog" 2>/dev/null | grep -q RUNNING; then
			run_supervisorctl restart "$prog" 2>/dev/null || true
			continue
		fi
		run_supervisorctl start "$prog" 2>/dev/null \
			|| run_supervisorctl restart "$prog" 2>/dev/null \
			|| warn "启动 $prog 失败，请查看 aaPanel → Supervisor"
	done

	run_supervisorctl status "${progs[@]}" 2>/dev/null || true
}

restart_supervisor_programs() {
	local web_program="$1"
	local worker_program="$2"
	local -a progs=()

	[[ "${SKIP_SUPERVISOR_WEB:-0}" != "1" ]] && progs+=("$web_program")
	[[ "${SKIP_SUPERVISOR_WORKER:-0}" != "1" ]] && progs+=("$worker_program")

	if [[ ${#progs[@]} -eq 0 ]]; then
		return 0
	fi

	if [[ -z "$(find_supervisorctl)" ]]; then
		warn "未找到 supervisorctl，请手动在 aaPanel 重启 ${progs[*]}"
		return 1
	fi

	log "重启 Supervisor 进程: ${progs[*]}"
	if run_supervisorctl restart "${progs[@]}" 2>/dev/null; then
		log "Supervisor 重启成功"
	else
		for prog in "${progs[@]}"; do
			run_supervisorctl restart "$prog" || warn "重启 $prog 失败"
		done
	fi
}

health_check() {
	local port="$1"
	local body status attempt max_attempts interval url
	max_attempts="${HEALTHCHECK_RETRIES:-12}"
	interval="${HEALTHCHECK_INTERVAL:-5}"
	url="http://127.0.0.1:${port}/api/health"
	log "健康检查 http://127.0.0.1:${port}/api/health ..."
	sleep 2
	if command -v curl >/dev/null 2>&1; then
		for attempt in $(seq 1 "$max_attempts"); do
			if curl -fsS --connect-timeout 3 --max-time 8 "$url" >/dev/null; then
				log "健康检查通过 ✓"
				return 0
			fi
			body="$(curl -sS --connect-timeout 3 --max-time 6 "$url" 2>&1 || true)"
			status="$(curl -sS --connect-timeout 3 --max-time 6 -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || true)"
			if [[ "$attempt" -lt "$max_attempts" ]]; then
				warn "健康检查未就绪 (${attempt}/${max_attempts})，HTTP 状态: ${status:-000}，${interval}s 后重试"
				[[ -n "$body" ]] && warn "当前响应: $body"
				sleep "$interval"
			fi
		done
		[[ -n "$status" ]] && warn "健康检查 HTTP 状态: $status"
		[[ -n "$body" ]] && warn "健康检查响应: $body"
		warn "健康检查未通过或响应超时，请查看 aaPanel Node 项目日志、端口 ${port} 是否被正确监听，以及 MySQL 是否可连接"
		return 1
	fi
	warn "未安装 curl，跳过健康检查"
	return 0
}

print_supervisor_fix_hint() {
	local app_dir="$1"
	local web_program="$2"
	local worker_program="$3"

	warn "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	warn "Supervisor 未成功启动，请按以下步骤手动处理："
	warn "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	cat <<EOF

1) aaPanel → 软件商店 → Supervisor → 设置 → 重载/重启 Supervisor

2) 或 SSH 执行：
   /www/server/panel/pyenv/bin/supervisorctl -c /www/server/panel/plugin/supervisor/supervisord.conf reread
   /www/server/panel/pyenv/bin/supervisorctl -c /www/server/panel/plugin/supervisor/supervisord.conf update
   /www/server/panel/pyenv/bin/supervisorctl -c /www/server/panel/plugin/supervisor/supervisord.conf start ${web_program} ${worker_program}

3) 配置文件位置：
   ${app_dir}/deploy/aapanel/generated/${web_program}.conf
   ${app_dir}/deploy/aapanel/generated/${worker_program}.conf

4) 临时验证（不经过 Supervisor）：
   cd ${app_dir} && node build/index.js

EOF
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
