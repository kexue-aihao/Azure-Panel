import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDriver, getMysqlDb, getSqliteDb } from './index';
import type { AzureAccount, User, WorkflowLog, WorkflowPolicy } from './schema';
import {
	azureAccounts as sqliteAzureAccounts,
	users as sqliteUsers,
	workflowLogs as sqliteWorkflowLogs,
	workflowPolicies as sqliteWorkflowPolicies
} from './schema';
import {
	azureAccounts as mysqlAzureAccounts,
	users as mysqlUsers,
	workflowLogs as mysqlWorkflowLogs,
	workflowPolicies as mysqlWorkflowPolicies
} from './schema.mysql';

export async function findUserById(id: number): Promise<User | null> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const rows = await db.select().from(mysqlUsers).where(eq(mysqlUsers.id, id));
		return (rows[0] as User) ?? null;
	}

	return getSqliteDb().select().from(sqliteUsers).where(eq(sqliteUsers.id, id)).get() ?? null;
}

export async function findUserByEmail(email: string): Promise<User | null> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const rows = await db.select().from(mysqlUsers).where(eq(mysqlUsers.email, email));
		return (rows[0] as User) ?? null;
	}

	return getSqliteDb().select().from(sqliteUsers).where(eq(sqliteUsers.email, email)).get() ?? null;
}

export async function createUser(email: string, passwordHash: string): Promise<User> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const result = await db.insert(mysqlUsers).values({ email, passwordHash });
		const id = Number(result[0].insertId);
		return (await findUserById(id))!;
	}

	return getSqliteDb().insert(sqliteUsers).values({ email, passwordHash }).returning().get()!;
}

export async function listAccountsByUser(userId: number): Promise<AzureAccount[]> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const rows = await db.select().from(mysqlAzureAccounts).where(eq(mysqlAzureAccounts.userId, userId));
		return rows as AzureAccount[];
	}

	return getSqliteDb()
		.select()
		.from(sqliteAzureAccounts)
		.where(eq(sqliteAzureAccounts.userId, userId))
		.all();
}

export async function findAccountByUser(userId: number, accountId: number): Promise<AzureAccount | null> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const condition = and(eq(mysqlAzureAccounts.id, accountId), eq(mysqlAzureAccounts.userId, userId));
		const rows = await db.select().from(mysqlAzureAccounts).where(condition);
		return (rows[0] as AzureAccount) ?? null;
	}

	const condition = and(eq(sqliteAzureAccounts.id, accountId), eq(sqliteAzureAccounts.userId, userId));
	return getSqliteDb().select().from(sqliteAzureAccounts).where(condition).get() ?? null;
}

export async function insertAccount(
	values: Omit<AzureAccount, 'id' | 'createdAt'>
): Promise<AzureAccount> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const result = await db.insert(mysqlAzureAccounts).values(values as never);
		const id = Number(result[0].insertId);
		const rows = await db.select().from(mysqlAzureAccounts).where(eq(mysqlAzureAccounts.id, id));
		return rows[0] as AzureAccount;
	}

	return getSqliteDb().insert(sqliteAzureAccounts).values(values as never).returning().get()!;
}

export async function deleteAccount(accountId: number): Promise<void> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		await db.delete(mysqlAzureAccounts).where(eq(mysqlAzureAccounts.id, accountId));
		return;
	}

	getSqliteDb().delete(sqliteAzureAccounts).where(eq(sqliteAzureAccounts.id, accountId)).run();
}

export async function listWorkflowsByUser(userId: number): Promise<WorkflowPolicy[]> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const rows = await db
			.select()
			.from(mysqlWorkflowPolicies)
			.where(eq(mysqlWorkflowPolicies.userId, userId));
		return rows as WorkflowPolicy[];
	}

	return getSqliteDb()
		.select()
		.from(sqliteWorkflowPolicies)
		.where(eq(sqliteWorkflowPolicies.userId, userId))
		.all();
}

export async function findWorkflowByUser(
	userId: number,
	policyId: number
): Promise<WorkflowPolicy | null> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const condition = and(
			eq(mysqlWorkflowPolicies.id, policyId),
			eq(mysqlWorkflowPolicies.userId, userId)
		);
		const rows = await db.select().from(mysqlWorkflowPolicies).where(condition);
		return (rows[0] as WorkflowPolicy) ?? null;
	}

	const condition = and(
		eq(sqliteWorkflowPolicies.id, policyId),
		eq(sqliteWorkflowPolicies.userId, userId)
	);
	return getSqliteDb().select().from(sqliteWorkflowPolicies).where(condition).get() ?? null;
}

export async function insertWorkflow(values: Record<string, unknown>): Promise<WorkflowPolicy> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const result = await db.insert(mysqlWorkflowPolicies).values(values as never);
		const id = Number(result[0].insertId);
		const rows = await db.select().from(mysqlWorkflowPolicies).where(eq(mysqlWorkflowPolicies.id, id));
		return rows[0] as WorkflowPolicy;
	}

	return getSqliteDb().insert(sqliteWorkflowPolicies).values(values as never).returning().get()!;
}

export async function updateWorkflow(
	policyId: number,
	values: Record<string, unknown>
): Promise<WorkflowPolicy | null> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		await db.update(mysqlWorkflowPolicies).set(values as never).where(eq(mysqlWorkflowPolicies.id, policyId));
		const rows = await db.select().from(mysqlWorkflowPolicies).where(eq(mysqlWorkflowPolicies.id, policyId));
		return (rows[0] as WorkflowPolicy) ?? null;
	}

	return (
		getSqliteDb()
			.update(sqliteWorkflowPolicies)
			.set(values as never)
			.where(eq(sqliteWorkflowPolicies.id, policyId))
			.returning()
			.get() ?? null
	);
}

export async function deleteWorkflow(policyId: number): Promise<void> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		await db.delete(mysqlWorkflowPolicies).where(eq(mysqlWorkflowPolicies.id, policyId));
		return;
	}

	getSqliteDb().delete(sqliteWorkflowPolicies).where(eq(sqliteWorkflowPolicies.id, policyId)).run();
}

export async function listEnabledWorkflows(): Promise<WorkflowPolicy[]> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const rows = await db
			.select()
			.from(mysqlWorkflowPolicies)
			.where(eq(mysqlWorkflowPolicies.enabled, true));
		return rows as WorkflowPolicy[];
	}

	return getSqliteDb()
		.select()
		.from(sqliteWorkflowPolicies)
		.where(eq(sqliteWorkflowPolicies.enabled, true))
		.all();
}

export async function listEnabledWorkflowsByUser(userId: number): Promise<WorkflowPolicy[]> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const condition = and(
			eq(mysqlWorkflowPolicies.userId, userId),
			eq(mysqlWorkflowPolicies.enabled, true)
		);
		const rows = await db.select().from(mysqlWorkflowPolicies).where(condition);
		return rows as WorkflowPolicy[];
	}

	const condition = and(
		eq(sqliteWorkflowPolicies.userId, userId),
		eq(sqliteWorkflowPolicies.enabled, true)
	);
	return getSqliteDb().select().from(sqliteWorkflowPolicies).where(condition).all();
}

export async function findAccountById(accountId: number): Promise<AzureAccount | null> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const rows = await db.select().from(mysqlAzureAccounts).where(eq(mysqlAzureAccounts.id, accountId));
		return (rows[0] as AzureAccount) ?? null;
	}

	return getSqliteDb().select().from(sqliteAzureAccounts).where(eq(sqliteAzureAccounts.id, accountId)).get() ?? null;
}

export async function updateWorkflowLastRun(policyId: number): Promise<void> {
	const lastRunAt = new Date();
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		await db
			.update(mysqlWorkflowPolicies)
			.set({ lastRunAt })
			.where(eq(mysqlWorkflowPolicies.id, policyId));
		return;
	}

	getSqliteDb()
		.update(sqliteWorkflowPolicies)
		.set({ lastRunAt })
		.where(eq(sqliteWorkflowPolicies.id, policyId))
		.run();
}

export async function insertWorkflowLog(
	policyId: number,
	action: string,
	status: string,
	message: string
): Promise<void> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		await db.insert(mysqlWorkflowLogs).values({ policyId, action, status, message });
		return;
	}

	getSqliteDb().insert(sqliteWorkflowLogs).values({ policyId, action, status, message }).run();
}

export async function listWorkflowLogs(userId: number, policyId?: number): Promise<WorkflowLog[]> {
	const userPolicies = await listWorkflowsByUser(userId);
	const ids = userPolicies.map((p) => p.id);

	if (ids.length === 0) return [];
	if (policyId && !ids.includes(policyId)) return [];

	const targetIds = policyId ? [policyId] : ids;

	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const rows = await db
			.select()
			.from(mysqlWorkflowLogs)
			.where(inArray(mysqlWorkflowLogs.policyId, targetIds))
			.orderBy(desc(mysqlWorkflowLogs.id))
			.limit(100);
		return rows as WorkflowLog[];
	}

	return getSqliteDb()
		.select()
		.from(sqliteWorkflowLogs)
		.where(inArray(sqliteWorkflowLogs.policyId, targetIds))
		.orderBy(desc(sqliteWorkflowLogs.id))
		.limit(100)
		.all();
}
