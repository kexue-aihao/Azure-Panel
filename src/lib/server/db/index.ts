import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import { createPool, type Pool } from 'mysql2/promise';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readEnv } from '../runtime-env';
import * as sqliteSchema from './schema';
import * as mysqlSchema from './schema.mysql';

export type DbDriver = 'sqlite' | 'mysql';
export type SqliteDb = ReturnType<typeof drizzleSqlite<typeof sqliteSchema>>;
export type MysqlDb = ReturnType<typeof drizzleMysql<typeof mysqlSchema>>;

let driver: DbDriver = 'sqlite';
let sqliteDb: SqliteDb | null = null;
let mysqlPool: Pool | null = null;
let mysqlDb: MysqlDb | null = null;

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

export async function initDatabase() {
	driver = resolveDriver();

	if (driver === 'mysql') {
		mysqlPool = createPool({
			host: readEnv('MYSQL_HOST') ?? '127.0.0.1',
			port: Number(readEnv('MYSQL_PORT') ?? '3306'),
			user: readEnv('MYSQL_USER') ?? 'azure_panel',
			password: readEnv('MYSQL_PASSWORD') ?? '',
			database: readEnv('MYSQL_DATABASE') ?? 'azure_panel',
			waitForConnections: true,
			connectionLimit: 10
		});
		mysqlDb = drizzleMysql(mysqlPool, { schema: mysqlSchema, mode: 'default' }) as unknown as MysqlDb;
		console.log('[db] Connected to MySQL');
		return;
	}

	const dbPath = readEnv('SQLITE_PATH') ?? './data/azure-panel.db';
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
	console.log('[db] Connected to SQLite:', dbPath);
}
