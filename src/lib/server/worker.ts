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
	getPowerState,
	isAzureSubscriptionTriggerState,
	isRunning,
	randomAzureResourceName,
	startVm,
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
const VM_LIST_NEXT_TIMEOUT_MS = 20_000;

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
};

type TrackedVm = {
	name: string;
	resourceGroup: string;
	vmSize: string;
	accountId: number;
	accountName: string;
	clients: ReturnType<typeof createAzureClients>;
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

function safeReplenishTargetCount(policy: WorkflowPolicy) {
	const count = Number(policy.replenishTargetCount ?? policy.minRunningCount ?? 1);
	return Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
}

function resourceGroupFromId(resourceId?: string | null) {
	const match = String(resourceId ?? '').match(/resourceGroups\/([^/]+)/i);
	return match ? decodeURIComponent(match[1]) : '';
}

function policyResourcePrefix(policy: WorkflowPolicy) {
	const base = (policy.namePrefix || 'auto-vm').replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^-+|-+$/g, '');
	return `${base || 'auto-vm'}-w${policy.id}`.toLowerCase();
}

async function collectTrackedVms(
	policy: WorkflowPolicy,
	runtimes: WorkerAccountRuntime[]
) {
	const configuredNames = parseVmNames(policy.vmNamesJson);
	const configuredNameSet = new Set(configuredNames.map((name) => name.toLowerCase()));
	const prefix = policyResourcePrefix(policy);
	const tracked: TrackedVm[] = [];

	for (const runtime of runtimes) {
		try {
			const iterator = runtime.clients.compute.virtualMachines.listAll()[Symbol.asyncIterator]();
			try {
				while (true) {
					const next = await withTimeout(
						iterator.next(),
						VM_LIST_NEXT_TIMEOUT_MS,
						`账号 ${runtime.account.name} VM 列表读取超时`
					);
					if (next.done) break;
					const vm = next.value;
					if (!vm.name) continue;
					const resourceGroup = resourceGroupFromId(vm.id);
					if (!resourceGroup) continue;
					const lowerName = vm.name.toLowerCase();
					const isConfigured = configuredNameSet.size > 0 && configuredNameSet.has(lowerName);
					const isPolicyCreated = lowerName.startsWith(`${prefix}-`);
					if (isConfigured || isPolicyCreated) {
						tracked.push({
							name: vm.name,
							resourceGroup,
							vmSize: vm.hardwareProfile?.vmSize ?? '',
							accountId: runtime.account.id,
							accountName: runtime.account.name,
							clients: runtime.clients
						});
					}
				}
			} finally {
				const close = (iterator as { return?: () => Promise<unknown> }).return;
				await close?.call(iterator).catch(() => undefined);
			}
		} catch (err) {
			await insertWorkflowLog(
				policy.id,
				'inspect',
				'failed',
				`账号 ${runtime.account.name} VM 列表读取失败: ${errorMessage(err)}`
			);
		}
	}

	return tracked;
}

function selectVmSizeForReplenishment(runningVms: TrackedVm[], fallbackVmSize: string) {
	const counts = new Map<string, number>();
	for (const vm of runningVms) {
		if (!vm.vmSize) continue;
		counts.set(vm.vmSize, (counts.get(vm.vmSize) ?? 0) + 1);
	}
	const selected = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
	return selected || fallbackVmSize;
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

	const bootProxy = await pickValidatedBootProxy(
		policyId,
		options.bootProxyPool ?? [],
		`账号 ${account.name} 备用出口`
	);
	if (bootProxy) {
		return {
			proxy: bootProxy.proxy,
			label: `补机代理池 ${bootProxyLabel(bootProxy)}`
		};
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

async function collectAccountPoolRuntimes(
	policy: WorkflowPolicy,
	primaryAccount: AzureAccount,
	options: WorkerRuntimeOptions = {}
) {
	const accounts = await listAccountsByUser(policy.userId);
	const runtimes: WorkerAccountRuntime[] = [];
	await insertWorkflowLog(
		policy.id,
		'account_pool',
		accounts.length > 0 ? 'success' : 'warning',
		`Azure 号池当前共有 ${accounts.length} 个账号，自动补机会按添加顺序选择正常订阅账号`
	);
	for (const account of accounts) {
		try {
			const runtime = await createRuntimeForAccount(policy.id, account, options);
			if (runtime) runtimes.push(runtime);
		} catch (err) {
			await insertWorkflowLog(
				policy.id,
				'account_pool',
				'failed',
				`账号 ${account.name} 代理初始化失败: ${errorMessage(err)}`
			);
		}
	}

	if (!runtimes.some((runtime) => runtime.account.id === primaryAccount.id)) {
		const primaryRuntime = await createRuntimeForAccount(policy.id, primaryAccount, options);
		if (primaryRuntime) runtimes.push(primaryRuntime);
	}
	return runtimes;
}

async function pickReplenishmentRuntime(
	policy: WorkflowPolicy,
	runtimes: WorkerAccountRuntime[],
	excludedAccountId: number,
	startIndex = 0
): Promise<WorkerAccountRuntime | null> {
	const ordered = runtimes.filter((runtime) => runtime.account.id !== excludedAccountId);
	const offset = ordered.length > 0 ? Math.max(0, startIndex) % ordered.length : 0;
	const candidates = [...ordered.slice(offset), ...ordered.slice(0, offset)];
	await insertWorkflowLog(
		policy.id,
		'account_pool',
		candidates.length > 0 ? 'success' : 'warning',
		`本轮可按添加顺序选择的候选补机账号 ${candidates.length} 个`
	);
	for (const runtime of candidates) {
		try {
			const status = await getAccountSubscriptionStatus(runtime.account, runtime.proxy);
			const abnormal = isAzureSubscriptionTriggerState(
				status.state,
				DEFAULT_AZURE_SUBSCRIPTION_TRIGGER_STATES
			);
			const usable = !status.abnormal && !abnormal;
			await insertWorkflowLog(
				policy.id,
				'account_pool',
				usable ? 'success' : 'warning',
				`顺序候选补机账号 ${runtime.account.name} 订阅状态 ${status.state}${usable ? '，已选用' : '，跳过'}`
			);
			if (usable) return runtime;
		} catch (err) {
			await insertWorkflowLog(
				policy.id,
				'account_pool',
				'failed',
				`顺序候选补机账号 ${runtime.account.name} 状态检测失败: ${errorMessage(err)}`
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

			const bootProxyPool = await collectBootProxyPool(policy);
			const primaryRuntime = await createRuntimeForAccount(policy.id, account, { bootProxyPool });
			if (!primaryRuntime) continue;

			const status = await getAccountSubscriptionStatus(account, primaryRuntime.proxy);
			await updateWorkflowStatusCheck(policy.id, {
				lastAccountStatus: status.state,
				lastStatusCheckedAt: new Date()
			});

			const shouldReplenish = isAzureSubscriptionTriggerState(
				status.state,
				DEFAULT_AZURE_SUBSCRIPTION_TRIGGER_STATES
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
			const accountPoolRuntimes = await collectAccountPoolRuntimes(policy, account, { bootProxyPool });
			const replenishRuntimes = accountPoolRuntimes.filter(
				(runtime) => runtime.account.id !== account.id
			);
			const tracked = await collectTrackedVms(policy, replenishRuntimes);
			let running = 0;
			const runningVms: TrackedVm[] = [];
			const stopped: TrackedVm[] = [];

			for (const vm of tracked) {
				const state = await getPowerState(vm.clients, vm.resourceGroup, vm.name);
				if (isRunning(state)) {
					running += 1;
					runningVms.push(vm);
				} else {
					stopped.push(vm);
				}
			}
			const replenishmentVmSize = selectVmSizeForReplenishment(runningVms, policy.vmSize);

			await insertWorkflowLog(
				policy.id,
				'inspect',
				'success',
				`已跟踪健康号池中的本策略补机 VM ${tracked.length} 台，运行中 ${running} 台，停止 ${stopped.length} 台，目标 ${targetCount} 台，补机规格 ${replenishmentVmSize}`
			);

			if (policy.autoStart) {
				for (const vm of stopped) {
					if (running >= targetCount) break;
					try {
						await startVm(vm.clients, vm.resourceGroup, vm.name);
						await insertWorkflowLog(
							policy.id,
							'auto_start',
							'success',
							`已触发开机 ${vm.name}（账号 ${vm.accountName}）`
						);
						running += 1;
					} catch (err) {
						await insertWorkflowLog(
							policy.id,
							'auto_start',
							'failed',
							`开机失败 ${vm.name}: ${errorMessage(err)}`
						);
					}
				}
			}

			const deficit = Math.max(targetCount - running, 0);
			await insertWorkflowLog(
				policy.id,
				'auto_create',
				deficit > 0 ? 'running' : 'skipped',
				`补机计划已计算：触发账号=${account.name}，订阅状态=${status.state}，健康运行=${running}，目标=${targetCount}，需新建=${deficit}`
			);
			if (deficit <= 0) {
				await insertWorkflowLog(
					policy.id,
					'auto_create',
					'skipped',
					'健康号池中已有补机数量满足目标，本轮不再创建新 VM'
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
					let accountPoolCursor = 0;
					for (let i = 0; i < deficit; i++) {
						await insertWorkflowLog(
							policy.id,
							'auto_create',
							'running',
							`准备创建第 ${i + 1}/${deficit} 台补机，按账号添加顺序选择可用号池账号`
						);
						const replenishRuntime = await pickReplenishmentRuntime(
							policy,
							accountPoolRuntimes,
							account.id,
							accountPoolCursor
						);
						if (!replenishRuntime) {
							await insertWorkflowLog(
								policy.id,
								'auto_create',
								'failed',
								'账号池中没有可用于补机的正常订阅账号'
							);
							break;
						}
						const orderedCandidates = accountPoolRuntimes.filter(
							(runtime) => runtime.account.id !== account.id
						);
						const selectedIndex = orderedCandidates.findIndex(
							(runtime) => runtime.account.id === replenishRuntime.account.id
						);
						accountPoolCursor = selectedIndex >= 0 ? selectedIndex + 1 : accountPoolCursor + 1;
						const prefix = policyResourcePrefix(policy);
						const resourceGroup = randomAzureResourceName(`${prefix}-rg`, 64);
						const vmName = randomAzureResourceName(prefix, 48);
						const bootProxy = await pickValidatedBootProxy(
							policy.id,
							bootProxyPool,
							`创建补机 ${vmName}`
						);
						const createClients = bootProxy
							? createAzureClients(replenishRuntime.account, bootProxy.proxy)
							: replenishRuntime.clients;
						const createProxyLabel = bootProxy
							? `补机代理池 ${bootProxyLabel(bootProxy)}`
							: replenishRuntime.proxyLabel;
						try {
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
