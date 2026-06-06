import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDriver, getMysqlDb, getSqliteDb } from './index';
import type {
	AzureAccount,
	DnsConfig,
	DnsRecordBinding,
	ExecutionLog,
	NotificationSettings,
	ProxyProfile,
	SubscriptionNotificationState,
	User,
	WorkflowLog,
	WorkflowPolicy
} from './schema';
import {
	azureAccounts as sqliteAzureAccounts,
	dnsConfigs as sqliteDnsConfigs,
	dnsRecordBindings as sqliteDnsRecordBindings,
	executionLogs as sqliteExecutionLogs,
	notificationSettings as sqliteNotificationSettings,
	proxyProfiles as sqliteProxyProfiles,
	subscriptionNotificationStates as sqliteSubscriptionNotificationStates,
	users as sqliteUsers,
	workflowLogs as sqliteWorkflowLogs,
	workflowPolicies as sqliteWorkflowPolicies
} from './schema';
import {
	azureAccounts as mysqlAzureAccounts,
	dnsConfigs as mysqlDnsConfigs,
	dnsRecordBindings as mysqlDnsRecordBindings,
	executionLogs as mysqlExecutionLogs,
	notificationSettings as mysqlNotificationSettings,
	proxyProfiles as mysqlProxyProfiles,
	subscriptionNotificationStates as mysqlSubscriptionNotificationStates,
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

export async function updateProxyProfileType(
	userId: number,
	proxyProfileId: number,
	type: string
): Promise<void> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		await db
			.update(mysqlProxyProfiles)
			.set({ type })
			.where(and(eq(mysqlProxyProfiles.id, proxyProfileId), eq(mysqlProxyProfiles.userId, userId)));
		return;
	}

	getSqliteDb()
		.update(sqliteProxyProfiles)
		.set({ type })
		.where(and(eq(sqliteProxyProfiles.id, proxyProfileId), eq(sqliteProxyProfiles.userId, userId)))
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

export async function updateAccountProxy(
	userId: number,
	accountId: number,
	values: { proxyProfileId: number | null; proxyUrlEncrypted?: string }
): Promise<AzureAccount | null> {
	const updateValues = {
		proxyProfileId: values.proxyProfileId,
		proxyUrlEncrypted: values.proxyUrlEncrypted ?? ''
	};

	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		await db
			.update(mysqlAzureAccounts)
			.set(updateValues)
			.where(and(eq(mysqlAzureAccounts.id, accountId), eq(mysqlAzureAccounts.userId, userId)));
		const rows = await db
			.select()
			.from(mysqlAzureAccounts)
			.where(and(eq(mysqlAzureAccounts.id, accountId), eq(mysqlAzureAccounts.userId, userId)));
		return (rows[0] as AzureAccount) ?? null;
	}

	return (
		getSqliteDb()
			.update(sqliteAzureAccounts)
			.set(updateValues)
			.where(and(eq(sqliteAzureAccounts.id, accountId), eq(sqliteAzureAccounts.userId, userId)))
			.returning()
			.get() ?? null
	);
}

export async function deleteAccount(accountId: number): Promise<void> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		await db.delete(mysqlAzureAccounts).where(eq(mysqlAzureAccounts.id, accountId));
		return;
	}

	getSqliteDb().delete(sqliteAzureAccounts).where(eq(sqliteAzureAccounts.id, accountId)).run();
}

export async function listDnsConfigsByUser(userId: number): Promise<DnsConfig[]> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const rows = await db
			.select()
			.from(mysqlDnsConfigs)
			.where(eq(mysqlDnsConfigs.userId, userId))
			.orderBy(desc(mysqlDnsConfigs.id));
		return rows as DnsConfig[];
	}

	return getSqliteDb()
		.select()
		.from(sqliteDnsConfigs)
		.where(eq(sqliteDnsConfigs.userId, userId))
		.orderBy(desc(sqliteDnsConfigs.id))
		.all();
}

export async function findDnsConfigByUser(
	userId: number,
	configId: number
): Promise<DnsConfig | null> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const rows = await db
			.select()
			.from(mysqlDnsConfigs)
			.where(and(eq(mysqlDnsConfigs.id, configId), eq(mysqlDnsConfigs.userId, userId)));
		return (rows[0] as DnsConfig) ?? null;
	}

	return (
		getSqliteDb()
			.select()
			.from(sqliteDnsConfigs)
			.where(and(eq(sqliteDnsConfigs.id, configId), eq(sqliteDnsConfigs.userId, userId)))
			.get() ?? null
	);
}

export async function insertDnsConfig(
	values: Omit<DnsConfig, 'id' | 'createdAt'>
): Promise<DnsConfig> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const result = await db.insert(mysqlDnsConfigs).values(values as never).$returningId();
		const id = Number(result[0]?.id);
		if (!id) throw new Error('Failed to create DNS config');
		const rows = await db.select().from(mysqlDnsConfigs).where(eq(mysqlDnsConfigs.id, id));
		return rows[0] as DnsConfig;
	}

	return getSqliteDb().insert(sqliteDnsConfigs).values(values as never).returning().get()!;
}

export async function updateDnsConfig(
	userId: number,
	configId: number,
	values: Partial<Omit<DnsConfig, 'id' | 'userId' | 'createdAt'>>
): Promise<DnsConfig | null> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		await db
			.update(mysqlDnsConfigs)
			.set(values as never)
			.where(and(eq(mysqlDnsConfigs.id, configId), eq(mysqlDnsConfigs.userId, userId)));
		const rows = await db.select().from(mysqlDnsConfigs).where(eq(mysqlDnsConfigs.id, configId));
		return (rows[0] as DnsConfig) ?? null;
	}

	return (
		getSqliteDb()
			.update(sqliteDnsConfigs)
			.set(values as never)
			.where(and(eq(sqliteDnsConfigs.id, configId), eq(sqliteDnsConfigs.userId, userId)))
			.returning()
			.get() ?? null
	);
}

export async function deleteDnsConfig(userId: number, configId: number): Promise<void> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		await db
			.delete(mysqlDnsRecordBindings)
			.where(
				and(eq(mysqlDnsRecordBindings.configId, configId), eq(mysqlDnsRecordBindings.userId, userId))
			);
		await db
			.delete(mysqlDnsConfigs)
			.where(and(eq(mysqlDnsConfigs.id, configId), eq(mysqlDnsConfigs.userId, userId)));
		return;
	}

	const sqlite = getSqliteDb();
	sqlite
		.delete(sqliteDnsRecordBindings)
		.where(
			and(eq(sqliteDnsRecordBindings.configId, configId), eq(sqliteDnsRecordBindings.userId, userId))
		)
		.run();
	sqlite
		.delete(sqliteDnsConfigs)
		.where(and(eq(sqliteDnsConfigs.id, configId), eq(sqliteDnsConfigs.userId, userId)))
		.run();
}

export async function listDnsBindingsByUser(userId: number): Promise<DnsRecordBinding[]> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const rows = await db
			.select()
			.from(mysqlDnsRecordBindings)
			.where(eq(mysqlDnsRecordBindings.userId, userId))
			.orderBy(desc(mysqlDnsRecordBindings.id));
		return rows as DnsRecordBinding[];
	}

	return getSqliteDb()
		.select()
		.from(sqliteDnsRecordBindings)
		.where(eq(sqliteDnsRecordBindings.userId, userId))
		.orderBy(desc(sqliteDnsRecordBindings.id))
		.all();
}

export async function findDnsBindingByUser(
	userId: number,
	bindingId: number
): Promise<DnsRecordBinding | null> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const rows = await db
			.select()
			.from(mysqlDnsRecordBindings)
			.where(and(eq(mysqlDnsRecordBindings.id, bindingId), eq(mysqlDnsRecordBindings.userId, userId)));
		return (rows[0] as DnsRecordBinding) ?? null;
	}

	return (
		getSqliteDb()
			.select()
			.from(sqliteDnsRecordBindings)
			.where(and(eq(sqliteDnsRecordBindings.id, bindingId), eq(sqliteDnsRecordBindings.userId, userId)))
			.get() ?? null
	);
}

export async function insertDnsBinding(
	values: Omit<DnsRecordBinding, 'id' | 'createdAt' | 'lastSyncedAt'>
): Promise<DnsRecordBinding> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const result = await db.insert(mysqlDnsRecordBindings).values(values as never).$returningId();
		const id = Number(result[0]?.id);
		if (!id) throw new Error('Failed to create DNS binding');
		const rows = await db.select().from(mysqlDnsRecordBindings).where(eq(mysqlDnsRecordBindings.id, id));
		return rows[0] as DnsRecordBinding;
	}

	return getSqliteDb()
		.insert(sqliteDnsRecordBindings)
		.values(values as never)
		.returning()
		.get()!;
}

export async function updateDnsBinding(
	userId: number,
	bindingId: number,
	values: Partial<Omit<DnsRecordBinding, 'id' | 'userId' | 'createdAt'>>
): Promise<DnsRecordBinding | null> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		await db
			.update(mysqlDnsRecordBindings)
			.set(values as never)
			.where(and(eq(mysqlDnsRecordBindings.id, bindingId), eq(mysqlDnsRecordBindings.userId, userId)));
		const rows = await db
			.select()
			.from(mysqlDnsRecordBindings)
			.where(eq(mysqlDnsRecordBindings.id, bindingId));
		return (rows[0] as DnsRecordBinding) ?? null;
	}

	return (
		getSqliteDb()
			.update(sqliteDnsRecordBindings)
			.set(values as never)
			.where(and(eq(sqliteDnsRecordBindings.id, bindingId), eq(sqliteDnsRecordBindings.userId, userId)))
			.returning()
			.get() ?? null
	);
}

export async function deleteDnsBinding(userId: number, bindingId: number): Promise<void> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		await db
			.delete(mysqlDnsRecordBindings)
			.where(and(eq(mysqlDnsRecordBindings.id, bindingId), eq(mysqlDnsRecordBindings.userId, userId)));
		return;
	}

	getSqliteDb()
		.delete(sqliteDnsRecordBindings)
		.where(and(eq(sqliteDnsRecordBindings.id, bindingId), eq(sqliteDnsRecordBindings.userId, userId)))
		.run();
}

export async function updateDnsBindingSyncState(
	userId: number,
	bindingId: number,
	values: {
		lastARecordId?: string;
		lastAAAARecordId?: string;
		lastIpv4?: string;
		lastIpv6?: string;
		lastSyncedAt?: Date | null;
	}
): Promise<void> {
	await updateDnsBinding(userId, bindingId, values);
}

export async function findNotificationSettingsByUser(
	userId: number
): Promise<NotificationSettings | null> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const rows = await db
			.select()
			.from(mysqlNotificationSettings)
			.where(eq(mysqlNotificationSettings.userId, userId));
		return (rows[0] as NotificationSettings) ?? null;
	}

	return (
		getSqliteDb()
			.select()
			.from(sqliteNotificationSettings)
			.where(eq(sqliteNotificationSettings.userId, userId))
			.get() ?? null
	);
}

export async function listEnabledNotificationSettings(): Promise<NotificationSettings[]> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const rows = await db
			.select()
			.from(mysqlNotificationSettings)
			.where(eq(mysqlNotificationSettings.enabled, true));
		return rows as NotificationSettings[];
	}

	return getSqliteDb()
		.select()
		.from(sqliteNotificationSettings)
		.where(eq(sqliteNotificationSettings.enabled, true))
		.all();
}

export async function upsertNotificationSettings(
	userId: number,
	values: Partial<Omit<NotificationSettings, 'id' | 'userId' | 'createdAt'>>
): Promise<NotificationSettings> {
	const existing = await findNotificationSettingsByUser(userId);
	if (existing) {
		if (getDriver() === 'mysql') {
			const { db } = getMysqlDb();
			await db
				.update(mysqlNotificationSettings)
				.set(values as never)
				.where(eq(mysqlNotificationSettings.userId, userId));
			return (await findNotificationSettingsByUser(userId))!;
		}

		return getSqliteDb()
			.update(sqliteNotificationSettings)
			.set(values as never)
			.where(eq(sqliteNotificationSettings.userId, userId))
			.returning()
			.get()!;
	}

	const insertValues = {
		userId,
		telegramBotTokenEncrypted: '',
		telegramChatId: '',
		enabled: false,
		subscriptionCheckIntervalHours: 6,
		...values
	};

	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const result = await db
			.insert(mysqlNotificationSettings)
			.values(insertValues as never)
			.$returningId();
		const id = Number(result[0]?.id);
		if (!id) throw new Error('Failed to create notification settings');
		const rows = await db.select().from(mysqlNotificationSettings).where(eq(mysqlNotificationSettings.id, id));
		return rows[0] as NotificationSettings;
	}

	return getSqliteDb()
		.insert(sqliteNotificationSettings)
		.values(insertValues as never)
		.returning()
		.get()!;
}

export async function updateNotificationLastSubscriptionChecked(
	userId: number,
	checkedAt = new Date()
): Promise<void> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		await db
			.update(mysqlNotificationSettings)
			.set({ lastSubscriptionCheckedAt: checkedAt })
			.where(eq(mysqlNotificationSettings.userId, userId));
		return;
	}

	getSqliteDb()
		.update(sqliteNotificationSettings)
		.set({ lastSubscriptionCheckedAt: checkedAt })
		.where(eq(sqliteNotificationSettings.userId, userId))
		.run();
}

export async function findSubscriptionNotificationState(
	userId: number,
	accountId: number
): Promise<SubscriptionNotificationState | null> {
	const condition =
		getDriver() === 'mysql'
			? and(eq(mysqlSubscriptionNotificationStates.userId, userId), eq(mysqlSubscriptionNotificationStates.accountId, accountId))
			: and(eq(sqliteSubscriptionNotificationStates.userId, userId), eq(sqliteSubscriptionNotificationStates.accountId, accountId));

	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const rows = await db.select().from(mysqlSubscriptionNotificationStates).where(condition);
		return (rows[0] as SubscriptionNotificationState) ?? null;
	}

	return getSqliteDb().select().from(sqliteSubscriptionNotificationStates).where(condition).get() ?? null;
}

export async function upsertSubscriptionNotificationState(
	userId: number,
	accountId: number,
	values: Partial<
		Omit<SubscriptionNotificationState, 'id' | 'userId' | 'accountId' | 'createdAt'>
	>
): Promise<SubscriptionNotificationState> {
	const existing = await findSubscriptionNotificationState(userId, accountId);
	if (existing) {
		if (getDriver() === 'mysql') {
			const { db } = getMysqlDb();
			await db
				.update(mysqlSubscriptionNotificationStates)
				.set(values as never)
				.where(
					and(
						eq(mysqlSubscriptionNotificationStates.userId, userId),
						eq(mysqlSubscriptionNotificationStates.accountId, accountId)
					)
				);
			return (await findSubscriptionNotificationState(userId, accountId))!;
		}

		return getSqliteDb()
			.update(sqliteSubscriptionNotificationStates)
			.set(values as never)
			.where(
				and(
					eq(sqliteSubscriptionNotificationStates.userId, userId),
					eq(sqliteSubscriptionNotificationStates.accountId, accountId)
				)
			)
			.returning()
			.get()!;
	}

	const insertValues = {
		userId,
		accountId,
		subscriptionId: '',
		displayName: '',
		lastState: '',
		lastNotifiedState: '',
		...values
	};

	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const result = await db
			.insert(mysqlSubscriptionNotificationStates)
			.values(insertValues as never)
			.$returningId();
		const id = Number(result[0]?.id);
		if (!id) throw new Error('Failed to create subscription notification state');
		const rows = await db
			.select()
			.from(mysqlSubscriptionNotificationStates)
			.where(eq(mysqlSubscriptionNotificationStates.id, id));
		return rows[0] as SubscriptionNotificationState;
	}

	return getSqliteDb()
		.insert(sqliteSubscriptionNotificationStates)
		.values(insertValues as never)
		.returning()
		.get()!;
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

export async function updateWorkflowStatusCheck(
	policyId: number,
	values: { lastAccountStatus: string; lastStatusCheckedAt?: Date }
): Promise<void> {
	const updateValues = {
		lastAccountStatus: values.lastAccountStatus,
		lastStatusCheckedAt: values.lastStatusCheckedAt ?? new Date()
	};

	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		await db
			.update(mysqlWorkflowPolicies)
			.set(updateValues)
			.where(eq(mysqlWorkflowPolicies.id, policyId));
		return;
	}

	getSqliteDb()
		.update(sqliteWorkflowPolicies)
		.set(updateValues)
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

export type ExecutionLogInput = {
	userId: number;
	accountId?: number | null;
	source?: string;
	action: string;
	status: string;
	message: string;
	resourceGroup?: string;
	vmName?: string;
};

export type UnifiedExecutionLog = {
	id: number;
	source: string;
	policyId: number | null;
	accountId: number | null;
	action: string;
	status: string;
	message: string;
	resourceGroup: string;
	vmName: string;
	createdAt: Date;
};

export async function insertExecutionLog(input: ExecutionLogInput): Promise<void> {
	const values = {
		userId: input.userId,
		accountId: input.accountId ?? null,
		source: input.source ?? 'manual',
		action: input.action,
		status: input.status,
		message: input.message,
		resourceGroup: input.resourceGroup ?? '',
		vmName: input.vmName ?? ''
	};

	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		await db.insert(mysqlExecutionLogs).values(values);
		return;
	}

	getSqliteDb().insert(sqliteExecutionLogs).values(values).run();
}

export async function listExecutionLogs(userId: number): Promise<ExecutionLog[]> {
	if (getDriver() === 'mysql') {
		const { db } = getMysqlDb();
		const rows = await db
			.select()
			.from(mysqlExecutionLogs)
			.where(eq(mysqlExecutionLogs.userId, userId))
			.orderBy(desc(mysqlExecutionLogs.id))
			.limit(100);
		return rows as ExecutionLog[];
	}

	return getSqliteDb()
		.select()
		.from(sqliteExecutionLogs)
		.where(eq(sqliteExecutionLogs.userId, userId))
		.orderBy(desc(sqliteExecutionLogs.id))
		.limit(100)
		.all();
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

export async function listUnifiedExecutionLogs(
	userId: number,
	policyId?: number
): Promise<UnifiedExecutionLog[]> {
	const [workflowRows, executionRows] = await Promise.all([
		listWorkflowLogs(userId, policyId),
		policyId ? Promise.resolve([] as ExecutionLog[]) : listExecutionLogs(userId)
	]);
	const workflowItems: UnifiedExecutionLog[] = workflowRows.map((log) => ({
		id: log.id,
		source: 'workflow',
		policyId: log.policyId,
		accountId: null,
		action: log.action,
		status: log.status,
		message: log.message,
		resourceGroup: '',
		vmName: '',
		createdAt: log.createdAt
	}));
	const executionItems: UnifiedExecutionLog[] = executionRows.map((log) => ({
		id: log.id,
		source: log.source,
		policyId: null,
		accountId: log.accountId ?? null,
		action: log.action,
		status: log.status,
		message: log.message,
		resourceGroup: log.resourceGroup ?? '',
		vmName: log.vmName ?? '',
		createdAt: log.createdAt
	}));

	return [...workflowItems, ...executionItems]
		.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id)
		.slice(0, 100);
}
