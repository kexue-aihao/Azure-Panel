import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDriver, getMysqlDb, getSqliteDb } from './index';
import type { AzureAccount, ProxyProfile, User, WorkflowLog, WorkflowPolicy } from './schema';
import {
	azureAccounts as sqliteAzureAccounts,
	proxyProfiles as sqliteProxyProfiles,
	users as sqliteUsers,
	workflowLogs as sqliteWorkflowLogs,
	workflowPolicies as sqliteWorkflowPolicies
} from './schema';
import {
	azureAccounts as mysqlAzureAccounts,
	proxyProfiles as mysqlProxyProfiles,
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
		const result = await db.insert(mysqlUsers).values({ email, passwordHash }).$returningId();
		const id = Number(result[0]?.id);
		if (!id) throw new Error('Failed to create user');
		return (await findUserById(id))!;
	}

	return getSqliteDb().insert(sqliteUsers).values({ email, passwordHash }).returning().get()!;
}

export async function listProxyProfilesByUser(userId: number): Promise<ProxyProfile[]> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const rows = await db
			.select()
			.from(mysqlProxyProfiles)
			.where(eq(mysqlProxyProfiles.userId, userId))
			.orderBy(desc(mysqlProxyProfiles.id));
		return rows as ProxyProfile[];
	}

	return getSqliteDb()
		.select()
		.from(sqliteProxyProfiles)
		.where(eq(sqliteProxyProfiles.userId, userId))
		.orderBy(desc(sqliteProxyProfiles.id))
		.all();
}

export async function findProxyProfileByUser(
	userId: number,
	proxyProfileId: number
): Promise<ProxyProfile | null> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const condition = and(
			eq(mysqlProxyProfiles.id, proxyProfileId),
			eq(mysqlProxyProfiles.userId, userId)
		);
		const rows = await db.select().from(mysqlProxyProfiles).where(condition);
		return (rows[0] as ProxyProfile) ?? null;
	}

	const condition = and(
		eq(sqliteProxyProfiles.id, proxyProfileId),
		eq(sqliteProxyProfiles.userId, userId)
	);
	return getSqliteDb().select().from(sqliteProxyProfiles).where(condition).get() ?? null;
}

export async function insertProxyProfile(
	values: Omit<ProxyProfile, 'id' | 'createdAt'>
): Promise<ProxyProfile> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const result = await db.insert(mysqlProxyProfiles).values(values as never).$returningId();
		const id = Number(result[0]?.id);
		if (!id) throw new Error('Failed to create proxy profile');
		const rows = await db.select().from(mysqlProxyProfiles).where(eq(mysqlProxyProfiles.id, id));
		return rows[0] as ProxyProfile;
	}

	return getSqliteDb().insert(sqliteProxyProfiles).values(values as never).returning().get()!;
}

export async function updateProxyProfilePort(proxyProfileId: number, port: number): Promise<void> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		await db
			.update(mysqlProxyProfiles)
			.set({ port })
			.where(eq(mysqlProxyProfiles.id, proxyProfileId));
		return;
	}

	getSqliteDb()
		.update(sqliteProxyProfiles)
		.set({ port })
		.where(eq(sqliteProxyProfiles.id, proxyProfileId))
		.run();
}

export async function deleteProxyProfile(userId: number, proxyProfileId: number): Promise<void> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		await db
			.update(mysqlAzureAccounts)
			.set({ proxyProfileId: null })
			.where(
				and(
					eq(mysqlAzureAccounts.userId, userId),
					eq(mysqlAzureAccounts.proxyProfileId, proxyProfileId)
				)
			);
		await db
			.delete(mysqlProxyProfiles)
			.where(and(eq(mysqlProxyProfiles.id, proxyProfileId), eq(mysqlProxyProfiles.userId, userId)));
		return;
	}

	const sqlite = getSqliteDb();
	sqlite
		.update(sqliteAzureAccounts)
		.set({ proxyProfileId: null })
		.where(
			and(
				eq(sqliteAzureAccounts.userId, userId),
				eq(sqliteAzureAccounts.proxyProfileId, proxyProfileId)
			)
		)
		.run();
	sqlite
		.delete(sqliteProxyProfiles)
		.where(and(eq(sqliteProxyProfiles.id, proxyProfileId), eq(sqliteProxyProfiles.userId, userId)))
		.run();
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
	values: Omit<AzureAccount, 'id' | 'createdAt' | 'proxyProfileId' | 'proxyUrlEncrypted'> & {
		proxyProfileId?: number | null;
		proxyUrlEncrypted?: string | null;
	}
): Promise<AzureAccount> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const result = await db.insert(mysqlAzureAccounts).values(values as never).$returningId();
		const id = Number(result[0]?.id);
		if (!id) throw new Error('Failed to create Azure account');
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
		const result = await db.insert(mysqlWorkflowPolicies).values(values as never).$returningId();
		const id = Number(result[0]?.id);
		if (!id) throw new Error('Failed to create workflow');
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
