import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import {
	createPool,
	type FieldPacket,
	type Pool,
	type QueryResult,
	type QueryValues,
	type RowDataPacket
} from 'mysql2/promise';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { getConfiguredAdminEmails } from '../admin';
import { getProjectRoot, readEnv } from '../runtime-env';
import { markStartupStep } from '../startup-state';
import * as sqliteSchema from './schema';
import * as mysqlSchema from './schema.mysql';

export type DbDriver = 'sqlite' | 'mysql';
export type SqliteDb = ReturnType<typeof drizzleSqlite<typeof sqliteSchema>>;
export type MysqlDb = ReturnType<typeof drizzleMysql<typeof mysqlSchema>>;

let driver: DbDriver = 'sqlite';
let sqliteDb: SqliteDb | null = null;
let sqliteRawDb: Database.Database | null = null;
let mysqlPool: Pool | null = null;
let mysqlDb: MysqlDb | null = null;

const MYSQL_SCHEMA_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS users (
		id int NOT NULL AUTO_INCREMENT,
		email varchar(255) NOT NULL,
		password_hash varchar(255) NOT NULL,
		role varchar(16) NOT NULL DEFAULT 'user',
		disabled tinyint(1) NOT NULL DEFAULT 0,
		created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		UNIQUE KEY users_email_unique (email),
		KEY users_role_idx (role),
		KEY users_disabled_idx (disabled)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS proxy_profiles (
		id int NOT NULL AUTO_INCREMENT,
		user_id int NOT NULL,
		name varchar(120) NOT NULL,
		type varchar(16) NOT NULL,
		host varchar(255) NOT NULL,
		port int NOT NULL,
		username_encrypted text,
		password_encrypted text,
		managed_core varchar(16) DEFAULT '',
		share_link_encrypted text,
		created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		KEY proxy_profiles_user_id_idx (user_id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS azure_accounts (
		id int NOT NULL AUTO_INCREMENT,
		user_id int NOT NULL,
		name varchar(120) NOT NULL,
		tenant_id varchar(64) NOT NULL,
		client_id varchar(64) NOT NULL,
		client_secret_encrypted text NOT NULL,
		subscription_id varchar(64) NOT NULL,
		proxy_profile_id int NULL,
		proxy_url_encrypted text,
		vm_region_cache text,
		vm_image_cache text,
		vm_provider_cache text,
		remark varchar(255) DEFAULT '',
		created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		KEY azure_accounts_user_id_idx (user_id),
		KEY azure_accounts_proxy_profile_id_idx (proxy_profile_id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS dns_configs (
		id int NOT NULL AUTO_INCREMENT,
		user_id int NOT NULL,
		name varchar(120) NOT NULL,
		base_url varchar(255) NOT NULL,
		uid int NOT NULL,
		api_key_encrypted text NOT NULL,
		username_encrypted text,
		password_encrypted text,
		enabled tinyint(1) NOT NULL DEFAULT 1,
		created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		KEY dns_configs_user_id_idx (user_id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS dns_record_bindings (
		id int NOT NULL AUTO_INCREMENT,
		user_id int NOT NULL,
		config_id int NOT NULL,
		name varchar(120) NOT NULL,
		domain_id int NOT NULL,
		domain_name varchar(255) NOT NULL,
		subdomain varchar(255) NOT NULL DEFAULT '@',
		record_type varchar(16) NOT NULL DEFAULT 'A',
		line varchar(120) NOT NULL DEFAULT 'default',
		ttl int NOT NULL DEFAULT 60,
		weight int NULL,
		mx int NULL,
		remark varchar(255) DEFAULT '',
		enabled tinyint(1) NOT NULL DEFAULT 1,
		last_a_record_id varchar(128) DEFAULT '',
		last_aaaa_record_id varchar(128) DEFAULT '',
		last_ipv4 varchar(64) DEFAULT '',
		last_ipv6 varchar(128) DEFAULT '',
		last_synced_at timestamp NULL DEFAULT NULL,
		created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		KEY dns_record_bindings_user_id_idx (user_id),
		KEY dns_record_bindings_config_id_idx (config_id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS notification_settings (
		id int NOT NULL AUTO_INCREMENT,
		user_id int NOT NULL,
		telegram_bot_token_encrypted text NOT NULL,
		telegram_chat_id varchar(64) NOT NULL DEFAULT '',
		telegram_group_chat_ids text,
		enabled tinyint(1) NOT NULL DEFAULT 0,
		subscription_check_interval_hours int NOT NULL DEFAULT 6,
		last_subscription_checked_at timestamp NULL DEFAULT NULL,
		created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		UNIQUE KEY notification_settings_user_id_unique (user_id),
		KEY notification_settings_enabled_idx (enabled)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS subscription_notification_states (
		id int NOT NULL AUTO_INCREMENT,
		user_id int NOT NULL,
		account_id int NOT NULL,
		subscription_id varchar(64) NOT NULL DEFAULT '',
		display_name varchar(255) NOT NULL DEFAULT '',
		last_state varchar(64) NOT NULL DEFAULT '',
		last_notified_state varchar(64) NOT NULL DEFAULT '',
		last_checked_at timestamp NULL DEFAULT NULL,
		last_notified_at timestamp NULL DEFAULT NULL,
		created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		UNIQUE KEY subscription_notification_states_account_unique (user_id, account_id),
		KEY subscription_notification_states_user_id_idx (user_id),
		KEY subscription_notification_states_account_id_idx (account_id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS workflow_policies (
		id int NOT NULL AUTO_INCREMENT,
		user_id int NOT NULL,
		account_id int NOT NULL,
		name varchar(120) NOT NULL,
		enabled tinyint(1) NOT NULL DEFAULT 1,
		resource_group varchar(90) NOT NULL,
		location varchar(64) NOT NULL DEFAULT 'eastus',
		vm_names_json text NOT NULL,
		min_running_count int NOT NULL DEFAULT 1,
		replenish_target_count int NOT NULL DEFAULT 1,
		auto_start tinyint(1) NOT NULL DEFAULT 1,
		auto_create tinyint(1) NOT NULL DEFAULT 0,
		vm_size varchar(64) NOT NULL DEFAULT 'Standard_B1s',
		image_reference varchar(255) NOT NULL DEFAULT 'Canonical:ubuntu-24_04-lts:server:latest',
		name_prefix varchar(32) NOT NULL DEFAULT 'auto-vm',
		admin_username varchar(32) NOT NULL DEFAULT 'azureuser',
		admin_password_encrypted text NOT NULL,
		userdata_encrypted text NOT NULL,
		enable_ipv6 tinyint(1) NOT NULL DEFAULT 0,
		ip_prefix varchar(32) NOT NULL DEFAULT '',
		ip_brush_max_attempts int NOT NULL DEFAULT 30,
		check_interval_seconds int NOT NULL DEFAULT 120,
		status_check_enabled tinyint(1) NOT NULL DEFAULT 1,
		status_trigger_states varchar(120) NOT NULL DEFAULT 'banned,warning,warned,disabled',
		dns_binding_id int NOT NULL DEFAULT 0,
		last_account_status varchar(64) NOT NULL DEFAULT '',
		last_status_checked_at timestamp NULL DEFAULT NULL,
		last_run_at timestamp NULL DEFAULT NULL,
		created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		KEY workflow_policies_user_id_idx (user_id),
		KEY workflow_policies_account_id_idx (account_id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS workflow_logs (
		id int NOT NULL AUTO_INCREMENT,
		policy_id int NOT NULL,
		action varchar(64) NOT NULL,
		status varchar(32) NOT NULL,
		message text NOT NULL,
		created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		KEY workflow_logs_policy_id_idx (policy_id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS execution_logs (
		id int NOT NULL AUTO_INCREMENT,
		user_id int NOT NULL,
		account_id int NULL,
		source varchar(32) NOT NULL DEFAULT 'manual',
		action varchar(64) NOT NULL,
		status varchar(32) NOT NULL,
		message text NOT NULL,
		resource_group varchar(90) DEFAULT '',
		vm_name varchar(64) DEFAULT '',
		created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		KEY execution_logs_user_id_idx (user_id),
		KEY execution_logs_account_id_idx (account_id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];

function resolveDriver(): DbDriver {
	const configured = (readEnv('DB_DRIVER') ?? '').toLowerCase();
	if (configured === 'mysql') return 'mysql';
	if (readEnv('MYSQL_HOST') || readEnv('DATABASE_URL')?.startsWith('mysql')) return 'mysql';
	return 'sqlite';
}

export function getDriver() {
	return driver;
}

export function getMysqlDb(): { db: MysqlDb; pool: Pool } {
	if (!mysqlDb || !mysqlPool) throw new Error('MySQL database is not initialized');
	return { db: mysqlDb, pool: mysqlPool };
}

export function getSqliteDb(): SqliteDb {
	if (!sqliteDb) throw new Error('SQLite database is not initialized');
	return sqliteDb;
}

export function getSqliteRawDb(): Database.Database {
	if (!sqliteRawDb) throw new Error('SQLite database is not initialized');
	return sqliteRawDb;
}

export function getDb() {
	if (driver === 'mysql') {
		const { db, pool } = getMysqlDb();
		return { db, driver: 'mysql' as const, pool };
	}
	return { db: getSqliteDb(), driver: 'sqlite' as const };
}

function readPositiveIntEnv(key: string, fallback: number) {
	const value = Number(readEnv(key));
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function compactSql(sql: string) {
	return sql.replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function mysqlInitQuery<T extends QueryResult = QueryResult>(
	pool: Pool,
	sql: string,
	values?: QueryValues,
	step = `mysql:${compactSql(sql)}`
): Promise<[T, FieldPacket[]]> {
	markStartupStep(step);
	try {
		return await pool.query<T>({
			sql,
			values,
			timeout: readPositiveIntEnv('MYSQL_INIT_QUERY_TIMEOUT_MS', 10_000)
		});
	} catch (err) {
		const code = (err as { code?: string }).code;
		const message = err instanceof Error ? err.message : String(err);
		const wrapped = new Error(`${step} 失败${code ? ` (${code})` : ''}: ${message}`);
		(wrapped as Error & { code?: string }).code = code;
		throw wrapped;
	}
}

function countFromRows(rows: RowDataPacket[]) {
	return Number(rows[0]?.count ?? 0);
}

async function mysqlColumnExists(pool: Pool, table: string, column: string) {
	const [rows] = await mysqlInitQuery<RowDataPacket[]>(
		pool,
		`SELECT COUNT(*) AS count
		 FROM information_schema.COLUMNS
		 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
		[table, column],
		`mysql-schema:check-column:${table}.${column}`
	);
	return countFromRows(rows) > 0;
}

async function addMysqlColumnIfMissing(
	pool: Pool,
	table: string,
	column: string,
	definition: string
) {
	if (await mysqlColumnExists(pool, table, column)) return;
	await mysqlInitQuery(
		pool,
		`ALTER TABLE ${table} ADD COLUMN ${definition}`,
		undefined,
		`mysql-schema:add-column:${table}.${column}`
	).catch((err) => {
		if ((err as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw err;
	});
}

async function mysqlIndexExists(pool: Pool, table: string, index: string) {
	const [rows] = await mysqlInitQuery<RowDataPacket[]>(
		pool,
		`SELECT COUNT(*) AS count
		 FROM information_schema.STATISTICS
		 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
		[table, index],
		`mysql-schema:check-index:${table}.${index}`
	);
	return countFromRows(rows) > 0;
}

async function createMysqlIndexIfMissing(
	pool: Pool,
	table: string,
	index: string,
	createSql: string
) {
	if (await mysqlIndexExists(pool, table, index)) return;
	await mysqlInitQuery(pool, createSql, undefined, `mysql-schema:create-index:${table}.${index}`).catch(
		(err) => {
			if ((err as { code?: string }).code !== 'ER_DUP_KEYNAME') throw err;
		}
	);
}

async function ensureMysqlAdminUsers(pool: Pool) {
	const adminEmails = getConfiguredAdminEmails();
	for (const email of adminEmails) {
		await mysqlInitQuery(
			pool,
			"UPDATE users SET role = 'admin' WHERE LOWER(email) = ?",
			[email],
			'mysql-schema:admin-users:update-configured'
		);
	}

	const [rows] = await mysqlInitQuery<RowDataPacket[]>(
		pool,
		"SELECT COUNT(*) AS count FROM users WHERE role = 'admin'",
		undefined,
		'mysql-schema:admin-users:count'
	);
	const adminCount = Number(rows[0]?.count ?? 0);
	if (adminCount > 0) return;

	await mysqlInitQuery(
		pool,
		"UPDATE users SET role = 'admin' WHERE id = (SELECT id FROM (SELECT id FROM users ORDER BY id ASC LIMIT 1) first_user)",
		undefined,
		'mysql-schema:admin-users:promote-first'
	);
}

function ensureSqliteAdminUsers(sqlite: Database.Database) {
	const adminEmails = getConfiguredAdminEmails();
	for (const email of adminEmails) {
		sqlite.prepare("UPDATE users SET role = 'admin' WHERE lower(email) = ?").run(email);
	}

	const row = sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get() as
		| { count?: number }
		| undefined;
	const adminCount = Number(row?.count ?? 0);
	if (adminCount > 0) return;

	sqlite.exec(
		"UPDATE users SET role = 'admin' WHERE id = (SELECT id FROM users ORDER BY id ASC LIMIT 1)"
	);
}

async function ensureMysqlSchema(pool: Pool) {
	await mysqlInitQuery(pool, 'SELECT 1', undefined, 'mysql-schema:ping');
	for (const [index, statement] of MYSQL_SCHEMA_STATEMENTS.entries()) {
		await mysqlInitQuery(
			pool,
			statement,
			undefined,
			`mysql-schema:create-table:${index + 1}/${MYSQL_SCHEMA_STATEMENTS.length}`
		);
	}

	await addMysqlColumnIfMissing(pool, 'users', 'role', "role varchar(16) NOT NULL DEFAULT 'user'");
	await addMysqlColumnIfMissing(
		pool,
		'users',
		'disabled',
		'disabled tinyint(1) NOT NULL DEFAULT 0'
	);
	await mysqlInitQuery(
		pool,
		"UPDATE users SET role = 'user' WHERE role IS NULL OR role = ''",
		undefined,
		'mysql-schema:users:normalize-role'
	);
	await mysqlInitQuery(
		pool,
		'UPDATE users SET disabled = 0 WHERE disabled IS NULL',
		undefined,
		'mysql-schema:users:normalize-disabled'
	);
	await createMysqlIndexIfMissing(
		pool,
		'users',
		'users_role_idx',
		'CREATE INDEX users_role_idx ON users (role)'
	);
	await createMysqlIndexIfMissing(
		pool,
		'users',
		'users_disabled_idx',
		'CREATE INDEX users_disabled_idx ON users (disabled)'
	);
	await ensureMysqlAdminUsers(pool);

	await addMysqlColumnIfMissing(
		pool,
		'azure_accounts',
		'proxy_url_encrypted',
		'proxy_url_encrypted text NULL'
	);
	await addMysqlColumnIfMissing(
		pool,
		'azure_accounts',
		'proxy_profile_id',
		'proxy_profile_id int NULL'
	);
	await addMysqlColumnIfMissing(
		pool,
		'azure_accounts',
		'vm_region_cache',
		'vm_region_cache text NULL'
	);
	await addMysqlColumnIfMissing(
		pool,
		'azure_accounts',
		'vm_image_cache',
		'vm_image_cache text NULL'
	);
	await addMysqlColumnIfMissing(
		pool,
		'azure_accounts',
		'vm_provider_cache',
		'vm_provider_cache text NULL'
	);
	await createMysqlIndexIfMissing(
		pool,
		'azure_accounts',
		'azure_accounts_proxy_profile_id_idx',
		'CREATE INDEX azure_accounts_proxy_profile_id_idx ON azure_accounts (proxy_profile_id)'
	);

	await addMysqlColumnIfMissing(
		pool,
		'proxy_profiles',
		'managed_core',
		"managed_core varchar(16) DEFAULT ''"
	);
	await addMysqlColumnIfMissing(
		pool,
		'proxy_profiles',
		'share_link_encrypted',
		'share_link_encrypted text NULL'
	);

	await addMysqlColumnIfMissing(
		pool,
		'dns_configs',
		'username_encrypted',
		'username_encrypted text NULL'
	);
	await addMysqlColumnIfMissing(
		pool,
		'dns_configs',
		'password_encrypted',
		'password_encrypted text NULL'
	);

	await addMysqlColumnIfMissing(
		pool,
		'workflow_policies',
		'userdata_encrypted',
		'userdata_encrypted text NULL'
	);
	await mysqlInitQuery(
		pool,
		"UPDATE workflow_policies SET userdata_encrypted = '' WHERE userdata_encrypted IS NULL",
		undefined,
		'mysql-schema:workflow-policies:normalize-userdata'
	);
	await addMysqlColumnIfMissing(
		pool,
		'workflow_policies',
		'enable_ipv6',
		'enable_ipv6 tinyint(1) NOT NULL DEFAULT 0'
	);
	await addMysqlColumnIfMissing(
		pool,
		'workflow_policies',
		'ip_prefix',
		"ip_prefix varchar(32) NOT NULL DEFAULT ''"
	);
	await addMysqlColumnIfMissing(
		pool,
		'workflow_policies',
		'ip_brush_max_attempts',
		'ip_brush_max_attempts int NOT NULL DEFAULT 30'
	);
	const hadReplenishTargetCount = await mysqlColumnExists(
		pool,
		'workflow_policies',
		'replenish_target_count'
	);
	await addMysqlColumnIfMissing(
		pool,
		'workflow_policies',
		'replenish_target_count',
		'replenish_target_count int NOT NULL DEFAULT 1'
	);
	await mysqlInitQuery(
		pool,
		!hadReplenishTargetCount
			? 'UPDATE workflow_policies SET replenish_target_count = GREATEST(min_running_count, 1)'
			: 'UPDATE workflow_policies SET replenish_target_count = 1 WHERE replenish_target_count IS NULL OR replenish_target_count < 1',
		undefined,
		'mysql-schema:workflow-policies:normalize-replenish-target'
	);
	await addMysqlColumnIfMissing(
		pool,
		'workflow_policies',
		'status_check_enabled',
		'status_check_enabled tinyint(1) NOT NULL DEFAULT 1'
	);
	await addMysqlColumnIfMissing(
		pool,
		'workflow_policies',
		'status_trigger_states',
		"status_trigger_states varchar(120) NOT NULL DEFAULT 'banned,warning,warned,disabled'"
	);
	await mysqlInitQuery(
		pool,
		"UPDATE workflow_policies SET status_trigger_states = 'banned,warning,warned,disabled' WHERE LOWER(REPLACE(status_trigger_states, ' ', '')) = 'banned,warning,warned'",
		undefined,
		'mysql-schema:workflow-policies:normalize-trigger-states'
	);
	await addMysqlColumnIfMissing(
		pool,
		'workflow_policies',
		'dns_binding_id',
		'dns_binding_id int NOT NULL DEFAULT 0'
	);
	await addMysqlColumnIfMissing(
		pool,
		'workflow_policies',
		'last_account_status',
		"last_account_status varchar(64) NOT NULL DEFAULT ''"
	);
	await addMysqlColumnIfMissing(
		pool,
		'workflow_policies',
		'last_status_checked_at',
		'last_status_checked_at timestamp NULL DEFAULT NULL'
	);
	await addMysqlColumnIfMissing(
		pool,
		'notification_settings',
		'telegram_group_chat_ids',
		'telegram_group_chat_ids text NULL'
	);
}

export async function initDatabase() {
	driver = resolveDriver();

	if (driver === 'mysql') {
		const host = readEnv('MYSQL_HOST') ?? '127.0.0.1';
		const port = Number(readEnv('MYSQL_PORT') ?? '3306');
		const user = readEnv('MYSQL_USER') ?? 'azure_panel';
		const database = readEnv('MYSQL_DATABASE') ?? 'azure_panel';
		mysqlPool = createPool({
			host,
			port,
			user,
			password: readEnv('MYSQL_PASSWORD') ?? '',
			database,
			timezone: '+08:00',
			connectTimeout: readPositiveIntEnv('MYSQL_CONNECT_TIMEOUT_MS', 10_000),
			waitForConnections: true,
			connectionLimit: 10
		});
		mysqlPool.on('connection', (connection) => {
			void connection.query("SET time_zone = '+08:00'").catch((err) => {
				console.warn('[db] Failed to set MySQL session time_zone +08:00:', err);
			});
		});
		mysqlDb = drizzleMysql(mysqlPool, { schema: mysqlSchema, mode: 'default' }) as unknown as MysqlDb;
		await ensureMysqlSchema(mysqlPool);
		console.log(`[db] Connected to MySQL: ${user}@${host}:${port}/${database}`);
		return;
	}

	const configuredPath = readEnv('SQLITE_PATH') ?? './data/azure-panel.db';
	const dbPath = isAbsolute(configuredPath)
		? configuredPath
		: resolve(getProjectRoot(), configuredPath);
	mkdirSync(dirname(dbPath), { recursive: true });
	const sqlite = new Database(dbPath);
	sqlite.pragma('journal_mode = WAL');
	sqlite.pragma('foreign_keys = ON');
	sqliteDb = drizzleSqlite(sqlite, { schema: sqliteSchema });

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			email TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			role TEXT NOT NULL DEFAULT 'user',
			disabled INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS proxy_profiles (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			type TEXT NOT NULL,
			host TEXT NOT NULL,
			port INTEGER NOT NULL,
			username_encrypted TEXT DEFAULT '',
			password_encrypted TEXT DEFAULT '',
			managed_core TEXT DEFAULT '',
			share_link_encrypted TEXT DEFAULT '',
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS azure_accounts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			tenant_id TEXT NOT NULL,
			client_id TEXT NOT NULL,
			client_secret_encrypted TEXT NOT NULL,
			subscription_id TEXT NOT NULL,
			proxy_profile_id INTEGER REFERENCES proxy_profiles(id) ON DELETE SET NULL,
			proxy_url_encrypted TEXT DEFAULT '',
			vm_region_cache TEXT DEFAULT '',
			vm_image_cache TEXT DEFAULT '',
			vm_provider_cache TEXT DEFAULT '',
			remark TEXT DEFAULT '',
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS dns_configs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			base_url TEXT NOT NULL,
			uid INTEGER NOT NULL,
			api_key_encrypted TEXT NOT NULL,
			username_encrypted TEXT DEFAULT '',
			password_encrypted TEXT DEFAULT '',
			enabled INTEGER NOT NULL DEFAULT 1,
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS dns_record_bindings (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			config_id INTEGER NOT NULL REFERENCES dns_configs(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			domain_id INTEGER NOT NULL,
			domain_name TEXT NOT NULL,
			subdomain TEXT NOT NULL DEFAULT '@',
			record_type TEXT NOT NULL DEFAULT 'A',
			line TEXT NOT NULL DEFAULT 'default',
			ttl INTEGER NOT NULL DEFAULT 60,
			weight INTEGER,
			mx INTEGER,
			remark TEXT DEFAULT '',
			enabled INTEGER NOT NULL DEFAULT 1,
			last_a_record_id TEXT DEFAULT '',
			last_aaaa_record_id TEXT DEFAULT '',
			last_ipv4 TEXT DEFAULT '',
			last_ipv6 TEXT DEFAULT '',
			last_synced_at INTEGER,
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS notification_settings (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			telegram_bot_token_encrypted TEXT NOT NULL DEFAULT '',
			telegram_chat_id TEXT NOT NULL DEFAULT '',
			telegram_group_chat_ids TEXT NOT NULL DEFAULT '',
			enabled INTEGER NOT NULL DEFAULT 0,
			subscription_check_interval_hours INTEGER NOT NULL DEFAULT 6,
			last_subscription_checked_at INTEGER,
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS subscription_notification_states (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			account_id INTEGER NOT NULL REFERENCES azure_accounts(id) ON DELETE CASCADE,
			subscription_id TEXT NOT NULL DEFAULT '',
			display_name TEXT NOT NULL DEFAULT '',
			last_state TEXT NOT NULL DEFAULT '',
			last_notified_state TEXT NOT NULL DEFAULT '',
			last_checked_at INTEGER,
			last_notified_at INTEGER,
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS workflow_policies (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			account_id INTEGER NOT NULL REFERENCES azure_accounts(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1,
			resource_group TEXT NOT NULL,
			location TEXT NOT NULL DEFAULT 'eastus',
			vm_names_json TEXT NOT NULL DEFAULT '[]',
			min_running_count INTEGER NOT NULL DEFAULT 1,
			replenish_target_count INTEGER NOT NULL DEFAULT 1,
			auto_start INTEGER NOT NULL DEFAULT 1,
			auto_create INTEGER NOT NULL DEFAULT 0,
			vm_size TEXT NOT NULL DEFAULT 'Standard_B1s',
			image_reference TEXT NOT NULL DEFAULT 'Canonical:ubuntu-24_04-lts:server:latest',
			name_prefix TEXT NOT NULL DEFAULT 'auto-vm',
			admin_username TEXT NOT NULL DEFAULT 'azureuser',
			admin_password_encrypted TEXT NOT NULL DEFAULT '',
			userdata_encrypted TEXT NOT NULL DEFAULT '',
			enable_ipv6 INTEGER NOT NULL DEFAULT 0,
			ip_prefix TEXT NOT NULL DEFAULT '',
			ip_brush_max_attempts INTEGER NOT NULL DEFAULT 30,
			check_interval_seconds INTEGER NOT NULL DEFAULT 120,
			status_check_enabled INTEGER NOT NULL DEFAULT 1,
			status_trigger_states TEXT NOT NULL DEFAULT 'banned,warning,warned,disabled',
			dns_binding_id INTEGER NOT NULL DEFAULT 0,
			last_account_status TEXT NOT NULL DEFAULT '',
			last_status_checked_at INTEGER,
			last_run_at INTEGER,
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS workflow_logs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			policy_id INTEGER NOT NULL REFERENCES workflow_policies(id) ON DELETE CASCADE,
			action TEXT NOT NULL,
			status TEXT NOT NULL,
			message TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS execution_logs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			account_id INTEGER,
			source TEXT NOT NULL DEFAULT 'manual',
			action TEXT NOT NULL,
			status TEXT NOT NULL,
			message TEXT NOT NULL,
			resource_group TEXT DEFAULT '',
			vm_name TEXT DEFAULT '',
			created_at INTEGER NOT NULL
		);
	`);
	sqliteRawDb = sqlite;

	const userColumns = sqlite.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
	if (!userColumns.some((column) => column.name === 'role')) {
		sqlite.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
	}
	if (!userColumns.some((column) => column.name === 'disabled')) {
		sqlite.exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
	}
	sqlite.exec("UPDATE users SET role = 'user' WHERE role IS NULL OR role = ''");
	sqlite.exec('UPDATE users SET disabled = 0 WHERE disabled IS NULL');
	ensureSqliteAdminUsers(sqlite);

	const accountColumns = sqlite.prepare('PRAGMA table_info(azure_accounts)').all() as Array<{
		name: string;
	}>;
	if (!accountColumns.some((column) => column.name === 'proxy_url_encrypted')) {
		sqlite.exec("ALTER TABLE azure_accounts ADD COLUMN proxy_url_encrypted TEXT DEFAULT ''");
	}
	if (!accountColumns.some((column) => column.name === 'proxy_profile_id')) {
		sqlite.exec('ALTER TABLE azure_accounts ADD COLUMN proxy_profile_id INTEGER');
	}
	if (!accountColumns.some((column) => column.name === 'vm_region_cache')) {
		sqlite.exec("ALTER TABLE azure_accounts ADD COLUMN vm_region_cache TEXT DEFAULT ''");
	}
	if (!accountColumns.some((column) => column.name === 'vm_image_cache')) {
		sqlite.exec("ALTER TABLE azure_accounts ADD COLUMN vm_image_cache TEXT DEFAULT ''");
	}
	if (!accountColumns.some((column) => column.name === 'vm_provider_cache')) {
		sqlite.exec("ALTER TABLE azure_accounts ADD COLUMN vm_provider_cache TEXT DEFAULT ''");
	}
	const proxyColumns = sqlite.prepare('PRAGMA table_info(proxy_profiles)').all() as Array<{
		name: string;
	}>;
	if (!proxyColumns.some((column) => column.name === 'managed_core')) {
		sqlite.exec("ALTER TABLE proxy_profiles ADD COLUMN managed_core TEXT DEFAULT ''");
	}
	if (!proxyColumns.some((column) => column.name === 'share_link_encrypted')) {
		sqlite.exec("ALTER TABLE proxy_profiles ADD COLUMN share_link_encrypted TEXT DEFAULT ''");
	}
	const dnsConfigColumns = sqlite.prepare('PRAGMA table_info(dns_configs)').all() as Array<{
		name: string;
	}>;
	if (!dnsConfigColumns.some((column) => column.name === 'username_encrypted')) {
		sqlite.exec("ALTER TABLE dns_configs ADD COLUMN username_encrypted TEXT DEFAULT ''");
	}
	if (!dnsConfigColumns.some((column) => column.name === 'password_encrypted')) {
		sqlite.exec("ALTER TABLE dns_configs ADD COLUMN password_encrypted TEXT DEFAULT ''");
	}
	const workflowColumns = sqlite.prepare('PRAGMA table_info(workflow_policies)').all() as Array<{
		name: string;
	}>;
	if (!workflowColumns.some((column) => column.name === 'userdata_encrypted')) {
		sqlite.exec("ALTER TABLE workflow_policies ADD COLUMN userdata_encrypted TEXT NOT NULL DEFAULT ''");
	}
	if (!workflowColumns.some((column) => column.name === 'enable_ipv6')) {
		sqlite.exec('ALTER TABLE workflow_policies ADD COLUMN enable_ipv6 INTEGER NOT NULL DEFAULT 0');
	}
	if (!workflowColumns.some((column) => column.name === 'ip_prefix')) {
		sqlite.exec("ALTER TABLE workflow_policies ADD COLUMN ip_prefix TEXT NOT NULL DEFAULT ''");
	}
	if (!workflowColumns.some((column) => column.name === 'ip_brush_max_attempts')) {
		sqlite.exec(
			'ALTER TABLE workflow_policies ADD COLUMN ip_brush_max_attempts INTEGER NOT NULL DEFAULT 30'
		);
	}
	if (!workflowColumns.some((column) => column.name === 'replenish_target_count')) {
		sqlite.exec(
			'ALTER TABLE workflow_policies ADD COLUMN replenish_target_count INTEGER NOT NULL DEFAULT 1'
		);
		sqlite.exec(
			'UPDATE workflow_policies SET replenish_target_count = max(min_running_count, 1)'
		);
	}
	if (!workflowColumns.some((column) => column.name === 'status_check_enabled')) {
		sqlite.exec(
			'ALTER TABLE workflow_policies ADD COLUMN status_check_enabled INTEGER NOT NULL DEFAULT 1'
		);
	}
	if (!workflowColumns.some((column) => column.name === 'status_trigger_states')) {
		sqlite.exec(
			"ALTER TABLE workflow_policies ADD COLUMN status_trigger_states TEXT NOT NULL DEFAULT 'banned,warning,warned,disabled'"
		);
	}
	sqlite.exec(
		"UPDATE workflow_policies SET status_trigger_states = 'banned,warning,warned,disabled' WHERE lower(replace(status_trigger_states, ' ', '')) = 'banned,warning,warned'"
	);
	if (!workflowColumns.some((column) => column.name === 'dns_binding_id')) {
		sqlite.exec('ALTER TABLE workflow_policies ADD COLUMN dns_binding_id INTEGER NOT NULL DEFAULT 0');
	}
	if (!workflowColumns.some((column) => column.name === 'last_account_status')) {
		sqlite.exec("ALTER TABLE workflow_policies ADD COLUMN last_account_status TEXT NOT NULL DEFAULT ''");
	}
	if (!workflowColumns.some((column) => column.name === 'last_status_checked_at')) {
		sqlite.exec('ALTER TABLE workflow_policies ADD COLUMN last_status_checked_at INTEGER');
	}
	const notificationColumns = sqlite.prepare('PRAGMA table_info(notification_settings)').all() as Array<{
		name: string;
	}>;
	if (!notificationColumns.some((column) => column.name === 'telegram_group_chat_ids')) {
		sqlite.exec("ALTER TABLE notification_settings ADD COLUMN telegram_group_chat_ids TEXT NOT NULL DEFAULT ''");
	}
	sqlite.exec(`
		CREATE INDEX IF NOT EXISTS users_role_idx ON users(role);
		CREATE INDEX IF NOT EXISTS users_disabled_idx ON users(disabled);
		CREATE INDEX IF NOT EXISTS proxy_profiles_user_id_idx ON proxy_profiles(user_id);
		CREATE INDEX IF NOT EXISTS azure_accounts_proxy_profile_id_idx ON azure_accounts(proxy_profile_id);
		CREATE INDEX IF NOT EXISTS dns_configs_user_id_idx ON dns_configs(user_id);
		CREATE INDEX IF NOT EXISTS dns_record_bindings_user_id_idx ON dns_record_bindings(user_id);
		CREATE INDEX IF NOT EXISTS dns_record_bindings_config_id_idx ON dns_record_bindings(config_id);
		CREATE UNIQUE INDEX IF NOT EXISTS notification_settings_user_id_unique ON notification_settings(user_id);
		CREATE INDEX IF NOT EXISTS notification_settings_enabled_idx ON notification_settings(enabled);
		CREATE UNIQUE INDEX IF NOT EXISTS subscription_notification_states_account_unique ON subscription_notification_states(user_id, account_id);
		CREATE INDEX IF NOT EXISTS subscription_notification_states_user_id_idx ON subscription_notification_states(user_id);
		CREATE INDEX IF NOT EXISTS subscription_notification_states_account_id_idx ON subscription_notification_states(account_id);
		CREATE INDEX IF NOT EXISTS execution_logs_user_id_idx ON execution_logs(user_id);
		CREATE INDEX IF NOT EXISTS execution_logs_account_id_idx ON execution_logs(account_id);
	`);
	console.log('[db] Connected to SQLite:', dbPath);
}
