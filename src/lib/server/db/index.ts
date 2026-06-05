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
	`CREATE TABLE IF NOT EXISTS azure_accounts (
		id int NOT NULL AUTO_INCREMENT,
		user_id int NOT NULL,
		name varchar(120) NOT NULL,
		tenant_id varchar(64) NOT NULL,
		client_id varchar(64) NOT NULL,
		client_secret_encrypted text NOT NULL,
		subscription_id varchar(64) NOT NULL,
		proxy_url_encrypted text,
		remark varchar(255) DEFAULT '',
		created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		KEY azure_accounts_user_id_idx (user_id)
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
		CREATE TABLE IF NOT EXISTS azure_accounts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			tenant_id TEXT NOT NULL,
			client_id TEXT NOT NULL,
			client_secret_encrypted TEXT NOT NULL,
			subscription_id TEXT NOT NULL,
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
	`);
	const columns = sqlite.prepare('PRAGMA table_info(azure_accounts)').all() as Array<{ name: string }>;
	if (!columns.some((column) => column.name === 'proxy_url_encrypted')) {
		sqlite.exec("ALTER TABLE azure_accounts ADD COLUMN proxy_url_encrypted TEXT DEFAULT ''");
	}
	console.log('[db] Connected to SQLite:', dbPath);
}
