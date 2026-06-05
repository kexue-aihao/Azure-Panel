import { and, desc, eq } from 'drizzle-orm';
import { getDb, getSchema } from './index';
import type { AzureAccount, User, WorkflowPolicy } from './schema';

function tables() {
	return getSchema();
}

export async function findUserById(id: number): Promise<User | null> {
	const { db, driver } = getDb();
	const { users } = tables();
	if (driver === 'mysql') {
		const rows = await db.select().from(users).where(eq(users.id, id));
		return (rows[0] as User) ?? null;
	}
	return db.select().from(users).where(eq(users.id, id)).get() ?? null;
}

export async function findUserByEmail(email: string): Promise<User | null> {
	const { db, driver } = getDb();
	const { users } = tables();
	if (driver === 'mysql') {
		const rows = await db.select().from(users).where(eq(users.email, email));
		return (rows[0] as User) ?? null;
	}
	return db.select().from(users).where(eq(users.email, email)).get() ?? null;
}

export async function createUser(email: string, passwordHash: string): Promise<User> {
	const { db, driver } = getDb();
	const { users } = tables();
	if (driver === 'mysql') {
		const result = await db.insert(users).values({ email, passwordHash });
		const id = Number(result[0].insertId);
		return (await findUserById(id))!;
	}
	return db.insert(users).values({ email, passwordHash }).returning().get()!;
}

export async function listAccountsByUser(userId: number): Promise<AzureAccount[]> {
	const { db, driver } = getDb();
	const { azureAccounts } = tables();
	if (driver === 'mysql') {
		return db.select().from(azureAccounts).where(eq(azureAccounts.userId, userId)) as Promise<AzureAccount[]>;
	}
	return db.select().from(azureAccounts).where(eq(azureAccounts.userId, userId)).all();
}

export async function findAccountByUser(userId: number, accountId: number): Promise<AzureAccount | null> {
	const { db, driver } = getDb();
	const { azureAccounts } = tables();
	const condition = and(eq(azureAccounts.id, accountId), eq(azureAccounts.userId, userId));
	if (driver === 'mysql') {
		const rows = await db.select().from(azureAccounts).where(condition);
		return (rows[0] as AzureAccount) ?? null;
	}
	return db.select().from(azureAccounts).where(condition).get() ?? null;
}

export async function insertAccount(
	values: Omit<AzureAccount, 'id' | 'createdAt'>
): Promise<AzureAccount> {
	const { db, driver } = getDb();
	const { azureAccounts } = tables();
	if (driver === 'mysql') {
		const result = await db.insert(azureAccounts).values(values as never);
		const id = Number(result[0].insertId);
		const rows = await db.select().from(azureAccounts).where(eq(azureAccounts.id, id));
		return rows[0] as AzureAccount;
	}
	return db.insert(azureAccounts).values(values as never).returning().get()!;
}

export async function deleteAccount(accountId: number): Promise<void> {
	const { db, driver } = getDb();
	const { azureAccounts } = tables();
	if (driver === 'mysql') {
		await db.delete(azureAccounts).where(eq(azureAccounts.id, accountId));
		return;
	}
	db.delete(azureAccounts).where(eq(azureAccounts.id, accountId)).run();
}

export async function listWorkflowsByUser(userId: number): Promise<WorkflowPolicy[]> {
	const { db, driver } = getDb();
	const { workflowPolicies } = tables();
	if (driver === 'mysql') {
		return db
			.select()
			.from(workflowPolicies)
			.where(eq(workflowPolicies.userId, userId)) as Promise<WorkflowPolicy[]>;
	}
	return db.select().from(workflowPolicies).where(eq(workflowPolicies.userId, userId)).all();
}

export async function findWorkflowByUser(
	userId: number,
	policyId: number
): Promise<WorkflowPolicy | null> {
	const { db, driver } = getDb();
	const { workflowPolicies } = tables();
	const condition = and(eq(workflowPolicies.id, policyId), eq(workflowPolicies.userId, userId));
	if (driver === 'mysql') {
		const rows = await db.select().from(workflowPolicies).where(condition);
		return (rows[0] as WorkflowPolicy) ?? null;
	}
	return db.select().from(workflowPolicies).where(condition).get() ?? null;
}

export async function insertWorkflow(values: Record<string, unknown>): Promise<WorkflowPolicy> {
	const { db, driver } = getDb();
	const { workflowPolicies } = tables();
	if (driver === 'mysql') {
		const result = await db.insert(workflowPolicies).values(values as never);
		const id = Number(result[0].insertId);
		const rows = await db.select().from(workflowPolicies).where(eq(workflowPolicies.id, id));
		return rows[0] as WorkflowPolicy;
	}
	return db.insert(workflowPolicies).values(values as never).returning().get()!;
}

export async function updateWorkflow(
	policyId: number,
	values: Record<string, unknown>
): Promise<WorkflowPolicy | null> {
	const { db, driver } = getDb();
	const { workflowPolicies } = tables();
	if (driver === 'mysql') {
		await db.update(workflowPolicies).set(values as never).where(eq(workflowPolicies.id, policyId));
		const rows = await db.select().from(workflowPolicies).where(eq(workflowPolicies.id, policyId));
		return (rows[0] as WorkflowPolicy) ?? null;
	}
	return (
		db
			.update(workflowPolicies)
			.set(values as never)
			.where(eq(workflowPolicies.id, policyId))
			.returning()
			.get() ?? null
	);
}

export async function deleteWorkflow(policyId: number): Promise<void> {
	const { db, driver } = getDb();
	const { workflowPolicies } = tables();
	if (driver === 'mysql') {
		await db.delete(workflowPolicies).where(eq(workflowPolicies.id, policyId));
		return;
	}
	db.delete(workflowPolicies).where(eq(workflowPolicies.id, policyId)).run();
}

export async function listEnabledWorkflows(): Promise<WorkflowPolicy[]> {
	const { db, driver } = getDb();
	const { workflowPolicies } = tables();
	if (driver === 'mysql') {
		return db
			.select()
			.from(workflowPolicies)
			.where(eq(workflowPolicies.enabled, true)) as Promise<WorkflowPolicy[]>;
	}
	return db.select().from(workflowPolicies).where(eq(workflowPolicies.enabled, true)).all();
}

export async function findAccountById(accountId: number): Promise<AzureAccount | null> {
	const { db, driver } = getDb();
	const { azureAccounts } = tables();
	if (driver === 'mysql') {
		const rows = await db.select().from(azureAccounts).where(eq(azureAccounts.id, accountId));
		return (rows[0] as AzureAccount) ?? null;
	}
	return db.select().from(azureAccounts).where(eq(azureAccounts.id, accountId)).get() ?? null;
}

export async function updateWorkflowLastRun(policyId: number): Promise<void> {
	const { db, driver } = getDb();
	const { workflowPolicies } = tables();
	const lastRunAt = new Date();
	if (driver === 'mysql') {
		await db.update(workflowPolicies).set({ lastRunAt }).where(eq(workflowPolicies.id, policyId));
		return;
	}
	db.update(workflowPolicies).set({ lastRunAt }).where(eq(workflowPolicies.id, policyId)).run();
}

export async function insertWorkflowLog(
	policyId: number,
	action: string,
	status: string,
	message: string
): Promise<void> {
	const { db, driver } = getDb();
	const { workflowLogs } = tables();
	if (driver === 'mysql') {
		await db.insert(workflowLogs).values({ policyId, action, status, message });
		return;
	}
	db.insert(workflowLogs).values({ policyId, action, status, message }).run();
}

export async function listWorkflowLogs(userId: number, policyId?: number) {
	const { db, driver } = getDb();
	const { workflowLogs } = tables();
	const userPolicies = await listWorkflowsByUser(userId);
	const ids = new Set(userPolicies.map((p) => p.id));

	if (driver === 'mysql') {
		let logs = await db.select().from(workflowLogs).orderBy(desc(workflowLogs.id)).limit(100);
		logs = logs.filter((log) => ids.has(log.policyId));
		if (policyId) logs = logs.filter((log) => log.policyId === policyId);
		return logs;
	}

	let logs = db.select().from(workflowLogs).orderBy(desc(workflowLogs.id)).limit(100).all();
	logs = logs.filter((log) => ids.has(log.policyId));
	if (policyId) logs = logs.filter((log) => log.policyId === policyId);
	return logs;
}
