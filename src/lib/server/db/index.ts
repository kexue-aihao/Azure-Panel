import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import { createPool, type Pool } from 'mysql2/promise';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { getProjectRoot, readEnv } from '../runtime-env';
import * as sqliteSchema from './schema';
import * as mysqlSchema from './schema.mysql';

export type DbDriver = 'sqlite' | 'mysql';
export type SqliteDb = ReturnType<typeof drizzleSqlite<typeof sqliteSchema>>;
export type MysqlDb = ReturnType<typeof drizzleMysql<typeof mysqlSchema>>;

let driver: DbDriver = 'sqlite';
let sqliteDb: SqliteDb | null = null;
let mysqlPool: Pool | null = null;
let mysqlDb: MysqlDb | null = null;

const MYSQL_SCHEMA_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS users (
		id int NOT NULL AUTO_INCREMENT,
		email varchar(255) NOT NULL,
		password_hash varchar(255) NOT NULL,
		created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		UNIQUE KEY users_email_unique (email)
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
		remark varchar(255) DEFAULT '',
		created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		KEY azure_accounts_user_id_idx (user_id),
		KEY azure_accounts_proxy_profile_id_idx (proxy_profile_id)
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

export function getDb() {
	if (driver === 'mysql') {
		const { db, pool } = getMysqlDb();
		return { db, driver: 'mysql' as const, pool };
	}
	return { db: getSqliteDb(), driver: 'sqlite' as const };
}

async function ensureMysqlSchema(pool: Pool) {
	await pool.query('SELECT 1');
	for (const statement of MYSQL_SCHEMA_STATEMENTS) {
		await pool.query(statement);
	}
	await pool.query('ALTER TABLE azure_accounts ADD COLUMN proxy_url_encrypted text NULL').catch((err) => {
		if ((err as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw err;
	});
	await pool.query('ALTER TABLE azure_accounts ADD COLUMN proxy_profile_id int NULL').catch((err) => {
		if ((err as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw err;
	});
	await pool
		.query('CREATE INDEX azure_accounts_proxy_profile_id_idx ON azure_accounts (proxy_profile_id)')
		.catch((err) => {
			if ((err as { code?: string }).code !== 'ER_DUP_KEYNAME') throw err;
		});
	await pool
		.query("ALTER TABLE proxy_profiles ADD COLUMN managed_core varchar(16) DEFAULT ''")
		.catch((err) => {
			if ((err as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw err;
		});
	await pool
		.query('ALTER TABLE proxy_profiles ADD COLUMN share_link_encrypted text NULL')
		.catch((err) => {
			if ((err as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw err;
		});
	await pool
		.query('ALTER TABLE workflow_policies ADD COLUMN userdata_encrypted text NULL')
		.catch((err) => {
			if ((err as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw err;
		});
	await pool.query("UPDATE workflow_policies SET userdata_encrypted = '' WHERE userdata_encrypted IS NULL");
	await pool
		.query('ALTER TABLE workflow_policies ADD COLUMN enable_ipv6 tinyint(1) NOT NULL DEFAULT 0')
		.catch((err) => {
			if ((err as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw err;
		});
	await pool
		.query("ALTER TABLE workflow_policies ADD COLUMN ip_prefix varchar(32) NOT NULL DEFAULT ''")
		.catch((err) => {
			if ((err as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw err;
		});
	await pool
		.query(
			'ALTER TABLE workflow_policies ADD COLUMN ip_brush_max_attempts int NOT NULL DEFAULT 30'
		)
		.catch((err) => {
			if ((err as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw err;
		});
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
			waitForConnections: true,
			connectionLimit: 10
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
			remark TEXT DEFAULT '',
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
	const columns = sqlite.prepare('PRAGMA table_info(azure_accounts)').all() as Array<{ name: string }>;
	if (!columns.some((column) => column.name === 'proxy_url_encrypted')) {
		sqlite.exec("ALTER TABLE azure_accounts ADD COLUMN proxy_url_encrypted TEXT DEFAULT ''");
	}
	if (!columns.some((column) => column.name === 'proxy_profile_id')) {
		sqlite.exec('ALTER TABLE azure_accounts ADD COLUMN proxy_profile_id INTEGER');
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
	sqlite.exec(`
		CREATE INDEX IF NOT EXISTS proxy_profiles_user_id_idx ON proxy_profiles(user_id);
		CREATE INDEX IF NOT EXISTS azure_accounts_proxy_profile_id_idx ON azure_accounts(proxy_profile_id);
		CREATE INDEX IF NOT EXISTS execution_logs_user_id_idx ON execution_logs(user_id);
		CREATE INDEX IF NOT EXISTS execution_logs_account_id_idx ON execution_logs(account_id);
	`);
	console.log('[db] Connected to SQLite:', dbPath);
}
