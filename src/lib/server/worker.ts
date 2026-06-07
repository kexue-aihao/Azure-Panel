import { decryptSecret } from './crypto';
import { getWorkerIntervalMs } from './env';
import {
	findAccountById,
	findDnsBindingByUser,
	findDnsConfigByUser,
	findNotificationSettingsByUser,
	findSubscriptionNotificationState,
	findProxyProfileByUser,
	insertWorkflowLog,
	listAccountsByUser,
	listEnabledWorkflows,
	listEnabledWorkflowsByUser,
	listEnabledNotificationSettings,
	listProxyProfilesByUser,
	updateWorkflow,
	updateDnsBindingSyncState,
	updateNotificationLastSubscriptionChecked,
	upsertSubscriptionNotificationState,
	updateWorkflowLastRun,
	updateWorkflowStatusCheck
} from './db/repo';
import {
	DEFAULT_AZURE_SUBSCRIPTION_TRIGGER_STATES,
	createAzureClients,
	createVmSimple,
	getAccountSubscriptionStatus,
	isAzureSubscriptionTriggerState,
	randomAzureResourceName,
	type CreateVmProgressEvent,
	type CreateVmResult
} from './azure';
import type { AzureAccount, ProxyProfile, WorkflowPolicy } from './db/schema';
import { createRainbowDnsClient, syncDnsBindingToIp } from './dns';
import {
	maskProxy,
	proxyProfileToAzureReady,
	proxySource,
	validateProxyConnection,
	type ProxyRuntimeConfig
} from './proxy';
import {
	buildReplenishmentMessage,
	buildSubscriptionAlertMessage,
	getTelegramCredentials,
	normalizeSubscriptionCheckIntervalHours,
	sendTelegramMessageToTargets
} from './telegram';

let timer: NodeJS.Timeout | null = null;
const activePolicies = new Set<number>();
const activeNotificationUsers = new Set<number>();
const SUBSCRIPTION_STATUS_TIMEOUT_MS = 30_000;

type WorkerAccountRuntime = {
	account: AzureAccount;
	proxy: ProxyRuntimeConfig | null;
	proxyLabel: string;
	clients: ReturnType<typeof createAzureClients>;
};

type WorkerBootProxyRuntime = {
	name: string;
	proxy: ProxyRuntimeConfig;
};

type WorkerRuntimeOptions = {
	bootProxyPool?: WorkerBootProxyRuntime[];
	getBootProxyPool?: () => Promise<WorkerBootProxyRuntime[]>;
	fallbackToBootProxy?: boolean;
};

function errorMessage(err: unknown) {
	return err instanceof Error ? err.message : String(err);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timerId: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timerId = setTimeout(() => reject(new Error(message)), timeoutMs);
			})
		]);
	} finally {
		if (timerId) clearTimeout(timerId);
	}
}

async function getAccountSubscriptionStatusWithTimeout(
	account: AzureAccount,
	proxy: ProxyRuntimeConfig | null,
	label: string
) {
	return withTimeout(
		getAccountSubscriptionStatus(account, proxy),
		SUBSCRIPTION_STATUS_TIMEOUT_MS,
		`${label} 订阅状态查询超过 ${SUBSCRIPTION_STATUS_TIMEOUT_MS / 1000} 秒`
	);
}

function normalizedNotificationState(state?: string | null) {
	const normalized = String(state ?? '').trim().toLowerCase();
	return normalized === 'warned' ? 'warning' : normalized;
}

function shuffle<T>(items: T[]) {
	const result = [...items];
	for (let i = result.length - 1; i > 0; i -= 1) {
		const j = Math.floor(Math.random() * (i + 1));
		[result[i], result[j]] = [result[j], result[i]];
	}
	return result;
}

function shouldRunNotificationCheck(settings: {
	lastSubscriptionCheckedAt: Date | null;
	subscriptionCheckIntervalHours: number;
}) {
	if (!settings.lastSubscriptionCheckedAt) return true;
	const intervalHours = normalizeSubscriptionCheckIntervalHours(settings.subscriptionCheckIntervalHours);
	return Date.now() - settings.lastSubscriptionCheckedAt.getTime() >= intervalHours * 60 * 60 * 1000;
}

function parseVmNames(value: string) {
	try {
		const parsed = JSON.parse(value || '[]');
		return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
	} catch {
		return [];
	}
}

async function saveTrackedVmName(policy: WorkflowPolicy, vmName: string) {
	const names = parseVmNames(policy.vmNamesJson);
	if (!names.some((name) => name.toLowerCase() === vmName.toLowerCase())) {
		names.push(vmName);
		policy.vmNamesJson = JSON.stringify(names);
		await updateWorkflow(policy.id, { vmNamesJson: policy.vmNamesJson });
	}
}

function safeReplenishTargetCount(policy: WorkflowPolicy) {
	const count = Number(policy.replenishTargetCount ?? policy.minRunningCount ?? 1);
	return Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
}

function policyResourcePrefix(policy: WorkflowPolicy) {
	const base = (policy.namePrefix || 'auto-vm').replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^-+|-+$/g, '');
	return `${base || 'auto-vm'}-w${policy.id}`.toLowerCase();
}

function isBootProxyProfile(profile: ProxyProfile) {
	if (proxySource(profile) === 'client_ip') return false;
	return ['http', 'https', 'socks4', 'socks4a', 'socks5'].includes(String(profile.type).toLowerCase());
}

async function collectBootProxyPool(policy: WorkflowPolicy): Promise<WorkerBootProxyRuntime[]> {
	const profiles = await listProxyProfilesByUser(policy.userId);
	const bootProfiles = shuffle(profiles.filter(isBootProxyProfile));
	const pool: WorkerBootProxyRuntime[] = [];

	for (const profile of bootProfiles) {
		try {
			const proxy = await proxyProfileToAzureReady(profile, {
				timeoutMs: 10_000,
				autoDetectHttpSocks: true,
				updateProfileType: true
			});
			pool.push({
				name: profile.name,
				proxy
			});
		} catch (err) {
			await insertWorkflowLog(
				policy.id,
				'proxy_pool',
				'failed',
				`补机代理 ${profile.name} 初始化失败: ${errorMessage(err)}`
			);
		}
	}

	if (pool.length > 0) {
		await insertWorkflowLog(
			policy.id,
			'proxy_pool',
			'success',
			`已加载 ${pool.length} 个 HTTP/SOCKS 补机开机代理，将随机使用`
		);
	} else {
		await insertWorkflowLog(
			policy.id,
			'proxy_pool',
			'skipped',
			'未找到可用的 HTTP/SOCKS 补机开机代理，将回退使用账号绑定代理或直连'
		);
	}

	return pool;
}

function bootProxyLabel(proxy: WorkerBootProxyRuntime | null) {
	return proxy ? `${proxy.name} (${maskProxy(proxy.proxy)})` : '';
}

async function pickValidatedBootProxy(
	policyId: number,
	pool: WorkerBootProxyRuntime[],
	reason: string
) {
	if (pool.length === 0) return null;

	for (const candidate of shuffle(pool)) {
		try {
			const proxy = await validateProxyConnection(candidate.proxy, { timeoutMs: 10_000 });
			await insertWorkflowLog(
				policyId,
				'proxy_pool',
				'success',
				`${reason} 已切换到可用随机代理: ${candidate.name} (${maskProxy(proxy)})`
			);
			return { ...candidate, proxy };
		} catch (err) {
			await insertWorkflowLog(
				policyId,
				'proxy_pool',
				'failed',
				`${reason} 随机代理 ${candidate.name} 测活失败，继续切换下一个: ${errorMessage(err)}`
			);
		}
	}

	await insertWorkflowLog(
		policyId,
		'proxy_pool',
		'warning',
		`${reason} 没有找到可用随机代理，将回退到账号默认出口或直连`
	);
	return null;
}

async function resolveWorkerProxyForAccount(
	policyId: number,
	account: AzureAccount,
	options: WorkerRuntimeOptions = {}
): Promise<{ proxy: ProxyRuntimeConfig | null; label: string }> {
	const proxyProfile = account.proxyProfileId
		? await findProxyProfileByUser(account.userId, account.proxyProfileId)
		: null;

	if (proxyProfile && proxySource(proxyProfile) === 'client_ip') {
		if (policyId > 0) {
			await insertWorkflowLog(
				policyId,
				'account_pool',
				'skipped',
				`账号 ${account.name} 使用当前访问 IP 代理，后台定时任务无法获取访问者 IP，改用补机代理池或直连`
			);
		}
	} else if (proxyProfile) {
		try {
			const proxy = await proxyProfileToAzureReady(proxyProfile, {
				timeoutMs: 10_000,
				autoDetectHttpSocks: true,
				updateProfileType: true
			});
			return {
				proxy,
				label: `账号绑定代理 ${proxyProfile.name} (${maskProxy(proxy)})`
			};
		} catch (err) {
			if (policyId > 0) {
				await insertWorkflowLog(
					policyId,
					'account_pool',
					'warning',
					`账号 ${account.name} 绑定代理 ${proxyProfile.name} 当前不可用，将尝试补机代理池备用出口: ${errorMessage(err)}`
				);
			}
		}
	}

	if (options.fallbackToBootProxy !== false) {
		const bootProxyPool =
			options.bootProxyPool ?? (options.getBootProxyPool ? await options.getBootProxyPool() : []);
		const bootProxy = await pickValidatedBootProxy(
			policyId,
			bootProxyPool,
			`账号 ${account.name} 备用出口`
		);
		if (bootProxy) {
			return {
				proxy: bootProxy.proxy,
				label: `补机代理池 ${bootProxyLabel(bootProxy)}`
			};
		}
	}

	return { proxy: null, label: '服务器源站 IP/直连' };
}

async function createRuntimeForAccount(
	policyId: number,
	account: AzureAccount,
	options: WorkerRuntimeOptions = {}
): Promise<WorkerAccountRuntime | null> {
	const { proxy: runtimeProxy, label } = await resolveWorkerProxyForAccount(policyId, account, options);
	if (policyId > 0) {
		await insertWorkflowLog(policyId, 'account_pool', 'success', `账号 ${account.name} 检测出口: ${label}`);
	}
	return {
		account,
		proxy: runtimeProxy,
		proxyLabel: label,
		clients: createAzureClients(account, runtimeProxy)
	};
}

async function pickReplenishmentRuntimeFromPool(options: {
	policy: WorkflowPolicy;
	accounts: AzureAccount[];
	excludedAccountIds: Set<number>;
	startIndex?: number;
	getBootProxyPool: () => Promise<WorkerBootProxyRuntime[]>;
}): Promise<{ runtime: WorkerAccountRuntime; selectedIndex: number } | null> {
	const ordered = options.accounts.filter((account) => !options.excludedAccountIds.has(account.id));
	const offset = ordered.length > 0 ? Math.max(0, options.startIndex ?? 0) % ordered.length : 0;
	const candidates = [...ordered.slice(offset), ...ordered.slice(0, offset)];
	await insertWorkflowLog(
		options.policy.id,
		'account_pool',
		candidates.length > 0 ? 'success' : 'warning',
		`本轮可按添加顺序选择的候选补机账号 ${candidates.length} 个`
	);

	for (const candidate of candidates) {
		try {
			const runtime = await createRuntimeForAccount(options.policy.id, candidate, {
				getBootProxyPool: options.getBootProxyPool
			});
			if (!runtime) continue;

			const status = await getAccountSubscriptionStatusWithTimeout(
				runtime.account,
				runtime.proxy,
				`候选补机账号 ${runtime.account.name}`
			);
			const abnormal = isAzureSubscriptionTriggerState(
				status.state,
				DEFAULT_AZURE_SUBSCRIPTION_TRIGGER_STATES
			);
			const usable = !status.abnormal && !abnormal;
			await insertWorkflowLog(
				options.policy.id,
				'account_pool',
				usable ? 'success' : 'warning',
				`顺序候选补机账号 ${runtime.account.name} 订阅状态 ${status.state}${usable ? '，已选用' : '，跳过'}`
			);
			if (usable) {
				const selectedIndex = ordered.findIndex((account) => account.id === runtime.account.id);
				return { runtime, selectedIndex: selectedIndex >= 0 ? selectedIndex : offset };
			}
		} catch (err) {
			await insertWorkflowLog(
				options.policy.id,
				'account_pool',
				'failed',
				`顺序候选补机账号 ${candidate.name} 状态检测失败: ${errorMessage(err)}`
			);
		}
	}
	return null;
}

async function logCreateProgress(policyId: number, event: CreateVmProgressEvent) {
	await insertWorkflowLog(policyId, `create:${event.step}`, event.status, event.message);
}

async function notifyReplenishmentSuccess(options: {
	policy: WorkflowPolicy;
	account: AzureAccount;
	result: CreateVmResult;
	vmSize: string;
}) {
	try {
		const settings = await findNotificationSettingsByUser(options.policy.userId);
		const credentials = getTelegramCredentials(settings);
		if (!credentials) return;
		await sendTelegramMessageToTargets({
			token: credentials.token,
			chatIds: credentials.chatIds,
			text: buildReplenishmentMessage({
				policyName: options.policy.name,
				account: options.account,
				vmName: options.result.name,
				resourceGroup: options.result.resourceGroup,
				vmSize: options.vmSize,
				location: options.policy.location,
				publicIPv4: options.result.publicIPv4,
				publicIPv6: options.result.publicIPv6
			})
		});
		await insertWorkflowLog(options.policy.id, 'telegram_notify', 'success', '补机成功通知已发送到 Telegram');
	} catch (err) {
		await insertWorkflowLog(
			options.policy.id,
			'telegram_notify',
			'failed',
			`Telegram 补机通知发送失败: ${errorMessage(err)}`
		);
	}
}

async function syncWorkflowDns(options: {
	policy: WorkflowPolicy;
	result: CreateVmResult;
}): Promise<void> {
	if (!options.policy.dnsBindingId) {
		await insertWorkflowLog(options.policy.id, 'dns_sync', 'skipped', '未配置 DNS 绑定，跳过解析同步');
		return;
	}

	const binding = await findDnsBindingByUser(options.policy.userId, options.policy.dnsBindingId);
	if (!binding || !binding.enabled) {
		await insertWorkflowLog(options.policy.id, 'dns_sync', 'skipped', 'DNS 绑定不存在或已停用');
		return;
	}

	const config = await findDnsConfigByUser(options.policy.userId, binding.configId);
	if (!config || !config.enabled) {
		await insertWorkflowLog(options.policy.id, 'dns_sync', 'skipped', 'DNS 配置不存在或已停用');
		return;
	}

	try {
		const syncResult = await syncDnsBindingToIp(createRainbowDnsClient(config), binding, {
			ipv4: options.result.publicIPv4,
			ipv6: options.result.publicIPv6,
			vmName: options.result.name,
			resourceGroup: options.result.resourceGroup
		});

		await updateDnsBindingSyncState(options.policy.userId, binding.id, {
			lastARecordId: syncResult.lastARecordId,
			lastAAAARecordId: syncResult.lastAAAARecordId,
			lastIpv4: syncResult.lastIpv4,
			lastIpv6: syncResult.lastIpv6,
			lastSyncedAt: new Date()
		});

		await insertWorkflowLog(
			options.policy.id,
			'dns_sync',
			'success',
			`DNS 已同步到 ${syncResult.fqdn}，新增 ${syncResult.created.join(',') || '-'}，更新 ${
				syncResult.updated.join(',') || '-'
			}`
		);
	} catch (err) {
		await insertWorkflowLog(
			options.policy.id,
			'dns_sync',
			'failed',
			err instanceof Error ? err.message : String(err)
		);
	}
}

async function runPolicies(policies: WorkflowPolicy[]) {
	for (const policy of policies) {
		if (activePolicies.has(policy.id)) continue;

		activePolicies.add(policy.id);

		try {
			if (!policy.statusCheckEnabled) {
				await insertWorkflowLog(policy.id, 'status_check', 'skipped', '账号状态检测未启用，本轮不执行自动补机');
				continue;
			}

			const account = await findAccountById(policy.accountId);
			if (!account) {
				await insertWorkflowLog(policy.id, 'policy_error', 'failed', '关联 Azure 账号不存在');
				continue;
			}

			const primaryRuntime = await createRuntimeForAccount(policy.id, account, {
				fallbackToBootProxy: false
			});
			if (!primaryRuntime) continue;

			const status = await getAccountSubscriptionStatusWithTimeout(
				account,
				primaryRuntime.proxy,
				`触发账号 ${account.name}`
			);
			await updateWorkflowStatusCheck(policy.id, {
				lastAccountStatus: status.state,
				lastStatusCheckedAt: new Date()
			});

			const shouldReplenish = isAzureSubscriptionTriggerState(
				status.state,
				policy.statusTriggerStates || DEFAULT_AZURE_SUBSCRIPTION_TRIGGER_STATES
			);
			await notifySubscriptionStateIfNeeded({
				settingsUserId: policy.userId,
				account,
				status
			}).catch((err) => {
				console.warn('[worker] failed to send subscription status notification:', err);
			});
			await insertWorkflowLog(
				policy.id,
				'status_check',
				shouldReplenish ? 'warning' : 'success',
				`订阅状态: ${status.state}，${shouldReplenish ? '命中补机触发条件' : '未命中补机触发条件，跳过本轮'}`
			);
			if (!shouldReplenish) continue;

			const targetCount = safeReplenishTargetCount(policy);
			const trackedVmNames = parseVmNames(policy.vmNamesJson);
			const trackedCount = trackedVmNames.length;
			const replenishmentVmSize = policy.vmSize;
			const deficit = Math.max(targetCount - trackedCount, 0);
			await insertWorkflowLog(
				policy.id,
				'auto_create',
				deficit > 0 ? 'running' : 'skipped',
				`订阅异常已触发补机计划：触发账号=${account.name}，订阅状态=${status.state}，已记录补机=${trackedCount}，目标=${targetCount}，需新建=${deficit}，规格=${replenishmentVmSize}`
			);
			if (deficit <= 0) {
				await insertWorkflowLog(
					policy.id,
					'auto_create',
					'skipped',
					'策略已记录的补机数量满足目标，本轮不再创建新 VM；如果这些 VM 已被手动删除，请在策略里清空绑定 VM 名称后重新触发'
				);
				continue;
			}

			if (!policy.autoCreate) {
				await insertWorkflowLog(
					policy.id,
					'auto_create',
					'warning',
					'策略未开启“自动创建新 VM”，但当前订阅异常已命中补机条件，将按补机策略立即创建'
				);
			}

			if (deficit > 0) {
				const password = decryptSecret(policy.adminPasswordEncrypted);
				const userdata = decryptSecret(policy.userdataEncrypted ?? '');
				if (!password) {
					await insertWorkflowLog(policy.id, 'auto_create', 'failed', '未配置管理员密码，无法自动补机');
				} else {
					const accounts = await listAccountsByUser(policy.userId);
					await insertWorkflowLog(
						policy.id,
						'account_pool',
						accounts.length > 0 ? 'success' : 'warning',
						`Azure 号池当前共有 ${accounts.length} 个账号，自动补机会按添加顺序逐个检测，选中第一个正常订阅账号`
					);
					let bootProxyPoolPromise: Promise<WorkerBootProxyRuntime[]> | null = null;
					const getBootProxyPool = () => {
						bootProxyPoolPromise ??= collectBootProxyPool(policy);
						return bootProxyPoolPromise;
					};
					let accountPoolCursor = 0;
					const excludedAccountIds = new Set([account.id]);
					for (let i = 0; i < deficit; i++) {
						await insertWorkflowLog(
							policy.id,
							'auto_create',
							'running',
							`准备创建第 ${i + 1}/${deficit} 台补机，按账号添加顺序选择可用号池账号`
						);
						const selected = await pickReplenishmentRuntimeFromPool({
							policy,
							accounts,
							excludedAccountIds,
							startIndex: accountPoolCursor,
							getBootProxyPool
						});
						const replenishRuntime = selected?.runtime ?? null;
						if (!replenishRuntime) {
							await insertWorkflowLog(
								policy.id,
								'auto_create',
								'failed',
								'账号池中没有可用于补机的正常订阅账号'
							);
							break;
						}
						excludedAccountIds.add(replenishRuntime.account.id);
						accountPoolCursor = selected
							? selected.selectedIndex + 1
							: accountPoolCursor + 1;
						const prefix = policyResourcePrefix(policy);
						const resourceGroup = randomAzureResourceName(`${prefix}-rg`, 64);
						const vmName = randomAzureResourceName(prefix, 48);
						const createClients = replenishRuntime.clients;
						const createProxyLabel = replenishRuntime.proxyLabel;
						try {
							await insertWorkflowLog(
								policy.id,
								'auto_create',
								'running',
								`已选用补机账号 ${replenishRuntime.account.name}，出口=${createProxyLabel}，开始创建 VM ${vmName}`
							);
							const result = await createVmSimple(createClients, {
								resourceGroup,
								location: policy.location,
								vmName,
								vmSize: replenishmentVmSize,
								imageReference: policy.imageReference,
								adminUsername: policy.adminUsername,
								adminPassword: password,
								enableIpv6: policy.enableIpv6,
								customData: userdata,
								ipPrefix: policy.ipPrefix,
								ipBrushMaxAttempts: policy.ipBrushMaxAttempts,
								progress: (event) => logCreateProgress(policy.id, event)
							});
							await insertWorkflowLog(
								policy.id,
								'auto_create',
								'success',
								`已使用账号 ${replenishRuntime.account.name} 创建 VM: ${vmName} 规格 ${replenishmentVmSize} 代理=${createProxyLabel} 资源组=${resourceGroup} IPv4=${result.publicIPv4 || '-'} IPv6=${
									result.publicIPv6 || '-'
								} 刷 IP 次数=${result.ipBrushAttempts}`
							);
							await saveTrackedVmName(policy, result.name);
							await notifyReplenishmentSuccess({
								policy,
								account: replenishRuntime.account,
								result,
								vmSize: replenishmentVmSize
							});
							await syncWorkflowDns({ policy, result });
						} catch (err) {
							await insertWorkflowLog(
								policy.id,
								'auto_create',
								'failed',
								`补机失败 ${vmName}: ${errorMessage(err)}`
							);
						}
					}
				}
			}
		} catch (err) {
			await insertWorkflowLog(policy.id, 'policy_error', 'failed', errorMessage(err));
		} finally {
			await updateWorkflowLastRun(policy.id).catch((err) => {
				console.warn('[worker] failed to update workflow last_run_at:', err);
			});
			activePolicies.delete(policy.id);
		}
	}
}

async function notifySubscriptionStateIfNeeded(options: {
	settingsUserId: number;
	account: AzureAccount;
	status: Awaited<ReturnType<typeof getAccountSubscriptionStatus>>;
}) {
	const now = new Date();
	const trigger = isAzureSubscriptionTriggerState(
		options.status.state,
		DEFAULT_AZURE_SUBSCRIPTION_TRIGGER_STATES
	);
	const existing = await findSubscriptionNotificationState(
		options.settingsUserId,
		options.account.id
	);
	const normalizedState = normalizedNotificationState(options.status.state) || 'unknown';
	const baseState = {
		subscriptionId: options.status.subscriptionId || options.account.subscriptionId,
		displayName: options.status.displayName || '',
		lastState: normalizedState,
		lastCheckedAt: now
	};

	if (!trigger) {
		await upsertSubscriptionNotificationState(options.settingsUserId, options.account.id, {
			...baseState,
			lastNotifiedState: ''
		});
		return;
	}

	const shouldNotify = existing?.lastNotifiedState !== normalizedState;
	if (!shouldNotify) {
		await upsertSubscriptionNotificationState(options.settingsUserId, options.account.id, baseState);
		return;
	}

	const settings = await findNotificationSettingsByUser(options.settingsUserId);
	const credentials = getTelegramCredentials(settings);
	if (!credentials) {
		await upsertSubscriptionNotificationState(options.settingsUserId, options.account.id, baseState);
		return;
	}

	await sendTelegramMessageToTargets({
		token: credentials.token,
		chatIds: credentials.chatIds,
		text: buildSubscriptionAlertMessage({
			account: options.account,
			subscriptionId: options.status.subscriptionId,
			displayName: options.status.displayName,
			state: options.status.state,
			checkedAt: now
		})
	});

	await upsertSubscriptionNotificationState(options.settingsUserId, options.account.id, {
		...baseState,
		lastNotifiedState: normalizedState,
		lastNotifiedAt: now
	});
}

async function runSubscriptionNotificationChecks(force = false) {
	const settingsRows = await listEnabledNotificationSettings();

	for (const settings of settingsRows) {
		if (!force && !shouldRunNotificationCheck(settings)) continue;
		if (activeNotificationUsers.has(settings.userId)) continue;

		activeNotificationUsers.add(settings.userId);
		try {
			const accounts = await listAccountsByUser(settings.userId);
			for (const account of accounts) {
				try {
					const runtime = await createRuntimeForAccount(0, account);
					if (!runtime) continue;
					const status = await getAccountSubscriptionStatus(account, runtime.proxy);
					await notifySubscriptionStateIfNeeded({
						settingsUserId: settings.userId,
						account,
						status
					});
				} catch (err) {
					console.warn(
						`[worker] Telegram subscription check failed for account ${account.id}:`,
						err
					);
				}
			}
			await updateNotificationLastSubscriptionChecked(settings.userId);
		} finally {
			activeNotificationUsers.delete(settings.userId);
		}
	}
}

export async function runWorkflowOnce() {
	await Promise.all([runPolicies(await listEnabledWorkflows()), runSubscriptionNotificationChecks()]);
}

export async function runWorkflowOnceForUser(userId: number, options: { force?: boolean } = {}) {
	await Promise.all([
		runPolicies(await listEnabledWorkflowsByUser(userId)),
		runSubscriptionNotificationChecks(options.force === true)
	]);
}

export function startWorker() {
	if (timer) return;
	const interval = getWorkerIntervalMs();
	timer = setInterval(() => {
		void runWorkflowOnce();
	}, interval);
	void runWorkflowOnce();
	console.log(`[worker] 自动补机引擎已启动，间隔 ${interval}ms`);
}

export function stopWorker() {
	if (timer) clearInterval(timer);
	timer = null;
}
