import {
	boolean,
	int,
	mysqlTable,
	text,
	timestamp,
	varchar
} from 'drizzle-orm/mysql-core';

export const users = mysqlTable('users', {
	id: int('id').primaryKey().autoincrement(),
	email: varchar('email', { length: 255 }).notNull().unique(),
	passwordHash: varchar('password_hash', { length: 255 }).notNull(),
	createdAt: timestamp('created_at').notNull().defaultNow()
});

export const proxyProfiles = mysqlTable('proxy_profiles', {
	id: int('id').primaryKey().autoincrement(),
	userId: int('user_id').notNull(),
	name: varchar('name', { length: 120 }).notNull(),
	type: varchar('type', { length: 16 }).notNull(),
	host: varchar('host', { length: 255 }).notNull(),
	port: int('port').notNull(),
	usernameEncrypted: text('username_encrypted').default(''),
	passwordEncrypted: text('password_encrypted').default(''),
	managedCore: varchar('managed_core', { length: 16 }).default(''),
	shareLinkEncrypted: text('share_link_encrypted').default(''),
	createdAt: timestamp('created_at').notNull().defaultNow()
});

export const azureAccounts = mysqlTable('azure_accounts', {
	id: int('id').primaryKey().autoincrement(),
	userId: int('user_id').notNull(),
	name: varchar('name', { length: 120 }).notNull(),
	tenantId: varchar('tenant_id', { length: 64 }).notNull(),
	clientId: varchar('client_id', { length: 64 }).notNull(),
	clientSecretEncrypted: text('client_secret_encrypted').notNull(),
	subscriptionId: varchar('subscription_id', { length: 64 }).notNull(),
	proxyProfileId: int('proxy_profile_id'),
	proxyUrlEncrypted: text('proxy_url_encrypted').default(''),
	remark: varchar('remark', { length: 255 }).default(''),
	createdAt: timestamp('created_at').notNull().defaultNow()
});

export const workflowPolicies = mysqlTable('workflow_policies', {
	id: int('id').primaryKey().autoincrement(),
	userId: int('user_id').notNull(),
	accountId: int('account_id').notNull(),
	name: varchar('name', { length: 120 }).notNull(),
	enabled: boolean('enabled').notNull().default(true),
	resourceGroup: varchar('resource_group', { length: 90 }).notNull(),
	location: varchar('location', { length: 64 }).notNull().default('eastus'),
	vmNamesJson: text('vm_names_json').notNull(),
	minRunningCount: int('min_running_count').notNull().default(1),
	autoStart: boolean('auto_start').notNull().default(true),
	autoCreate: boolean('auto_create').notNull().default(false),
	vmSize: varchar('vm_size', { length: 64 }).notNull().default('Standard_B1s'),
	imageReference: varchar('image_reference', { length: 255 })
		.notNull()
		.default('Canonical:ubuntu-24_04-lts:server:latest'),
	namePrefix: varchar('name_prefix', { length: 32 }).notNull().default('auto-vm'),
	adminUsername: varchar('admin_username', { length: 32 }).notNull().default('azureuser'),
	adminPasswordEncrypted: text('admin_password_encrypted').notNull(),
	userdataEncrypted: text('userdata_encrypted').notNull().default(''),
	enableIpv6: boolean('enable_ipv6').notNull().default(false),
	ipPrefix: varchar('ip_prefix', { length: 32 }).notNull().default(''),
	ipBrushMaxAttempts: int('ip_brush_max_attempts').notNull().default(30),
	checkIntervalSeconds: int('check_interval_seconds').notNull().default(120),
	lastRunAt: timestamp('last_run_at'),
	createdAt: timestamp('created_at').notNull().defaultNow()
});

export const workflowLogs = mysqlTable('workflow_logs', {
	id: int('id').primaryKey().autoincrement(),
	policyId: int('policy_id').notNull(),
	action: varchar('action', { length: 64 }).notNull(),
	status: varchar('status', { length: 32 }).notNull(),
	message: text('message').notNull(),
	createdAt: timestamp('created_at').notNull().defaultNow()
});

export const executionLogs = mysqlTable('execution_logs', {
	id: int('id').primaryKey().autoincrement(),
	userId: int('user_id').notNull(),
	accountId: int('account_id'),
	source: varchar('source', { length: 32 }).notNull().default('manual'),
	action: varchar('action', { length: 64 }).notNull(),
	status: varchar('status', { length: 32 }).notNull(),
	message: text('message').notNull(),
	resourceGroup: varchar('resource_group', { length: 90 }).default(''),
	vmName: varchar('vm_name', { length: 64 }).default(''),
	createdAt: timestamp('created_at').notNull().defaultNow()
});

export type User = typeof users.$inferSelect;
export type ProxyProfile = typeof proxyProfiles.$inferSelect;
export type AzureAccount = typeof azureAccounts.$inferSelect;
export type WorkflowPolicy = typeof workflowPolicies.$inferSelect;
export type WorkflowLog = typeof workflowLogs.$inferSelect;
export type ExecutionLog = typeof executionLogs.$inferSelect;
