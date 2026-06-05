import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	email: text('email').notNull().unique(),
	passwordHash: text('password_hash').notNull(),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

export const proxyProfiles = sqliteTable('proxy_profiles', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	type: text('type').notNull(),
	host: text('host').notNull(),
	port: integer('port').notNull(),
	usernameEncrypted: text('username_encrypted').default(''),
	passwordEncrypted: text('password_encrypted').default(''),
	managedCore: text('managed_core').default(''),
	shareLinkEncrypted: text('share_link_encrypted').default(''),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

export const azureAccounts = sqliteTable('azure_accounts', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	tenantId: text('tenant_id').notNull(),
	clientId: text('client_id').notNull(),
	clientSecretEncrypted: text('client_secret_encrypted').notNull(),
	subscriptionId: text('subscription_id').notNull(),
	proxyProfileId: integer('proxy_profile_id').references(() => proxyProfiles.id, {
		onDelete: 'set null'
	}),
	proxyUrlEncrypted: text('proxy_url_encrypted').default(''),
	remark: text('remark').default(''),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

export const workflowPolicies = sqliteTable('workflow_policies', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	accountId: integer('account_id')
		.notNull()
		.references(() => azureAccounts.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
	resourceGroup: text('resource_group').notNull(),
	location: text('location').notNull().default('eastus'),
	vmNamesJson: text('vm_names_json').notNull().default('[]'),
	minRunningCount: integer('min_running_count').notNull().default(1),
	autoStart: integer('auto_start', { mode: 'boolean' }).notNull().default(true),
	autoCreate: integer('auto_create', { mode: 'boolean' }).notNull().default(false),
	vmSize: text('vm_size').notNull().default('Standard_B1s'),
	imageReference: text('image_reference')
		.notNull()
		.default('Canonical:ubuntu-24_04-lts:server:latest'),
	namePrefix: text('name_prefix').notNull().default('auto-vm'),
	adminUsername: text('admin_username').notNull().default('azureuser'),
	adminPasswordEncrypted: text('admin_password_encrypted').notNull().default(''),
	userdataEncrypted: text('userdata_encrypted').notNull().default(''),
	enableIpv6: integer('enable_ipv6', { mode: 'boolean' }).notNull().default(false),
	ipPrefix: text('ip_prefix').notNull().default(''),
	ipBrushMaxAttempts: integer('ip_brush_max_attempts').notNull().default(30),
	checkIntervalSeconds: integer('check_interval_seconds').notNull().default(120),
	lastRunAt: integer('last_run_at', { mode: 'timestamp' }),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

export const workflowLogs = sqliteTable('workflow_logs', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	policyId: integer('policy_id')
		.notNull()
		.references(() => workflowPolicies.id, { onDelete: 'cascade' }),
	action: text('action').notNull(),
	status: text('status').notNull(),
	message: text('message').notNull(),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

export type User = typeof users.$inferSelect;
export type ProxyProfile = typeof proxyProfiles.$inferSelect;
export type AzureAccount = typeof azureAccounts.$inferSelect;
export type WorkflowPolicy = typeof workflowPolicies.$inferSelect;
export type WorkflowLog = typeof workflowLogs.$inferSelect;
