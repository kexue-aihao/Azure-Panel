import { getUserAccountWithSelectedProxy } from '$lib/server/accounts';
import {
	createAzureClients,
	createVmAdvanced,
	deleteResourceGroupWithProgress,
	formatAzureError,
	randomAzureResourceName,
	type AzureClients,
	type CreateVmOptions,
	type CreateVmProgressEvent,
	type CreateVmResult
} from '$lib/server/azure';
import {
	findDnsBindingByUser,
	findDnsConfigByUser,
	insertExecutionLog,
	updateDnsBindingSyncState
} from '$lib/server/db/repo';
import { createRainbowDnsClient, syncDnsBindingToIp } from '$lib/server/dns';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

type VmCreateResponse = {
	name: string;
	resource_group: string;
	location: string;
	public_ipv4: string;
	public_ipv6: string;
	ip_brush_attempts: number;
	ip_brush_matched: boolean;
};

type StreamContext = {
	userId: number;
	accountId: number;
	resourceGroup: string;
	vmName: string;
};

function publicResult(result: CreateVmResult): VmCreateResponse {
	return {
		name: result.name,
		resource_group: result.resourceGroup,
		location: result.location,
		public_ipv4: result.publicIPv4,
		public_ipv6: result.publicIPv6,
		ip_brush_attempts: result.ipBrushAttempts,
		ip_brush_matched: result.ipBrushMatched
	};
}

function streamMessage(controller: ReadableStreamDefaultController<Uint8Array>, payload: unknown) {
	controller.enqueue(new TextEncoder().encode(`${JSON.stringify(payload)}\n`));
}

function safeStreamMessage(
	controller: ReadableStreamDefaultController<Uint8Array>,
	payload: unknown
) {
	try {
		streamMessage(controller, payload);
		return true;
	} catch {
		return false;
	}
}

function createProgressEvent(
	step: string,
	status: CreateVmProgressEvent['status'],
	message: string,
	detail?: CreateVmProgressEvent['detail']
): CreateVmProgressEvent {
	return {
		step,
		status,
		message,
		detail,
		timestamp: new Date().toISOString()
	};
}

async function logVmCreateEvent(options: StreamContext & { event: CreateVmProgressEvent }) {
	await insertExecutionLog({
		userId: options.userId,
		accountId: options.accountId,
		source: 'vm_create',
		action: options.event.step,
		status: options.event.status,
		message: options.event.message,
		resourceGroup: options.resourceGroup,
		vmName: options.vmName
	}).catch((err) => {
		console.warn('[execution-log] failed to write VM create event:', err);
	});
}

async function cleanupGeneratedResourceGroupOnFailure(options: {
	clients: AzureClients | null;
	context: StreamContext;
	enabled: boolean;
	reason: string;
	progress: (event: CreateVmProgressEvent) => void | Promise<void>;
}) {
	if (!options.enabled || !options.clients) return null;
	try {
		await options.progress(
			createProgressEvent('cleanup-resource-group', 'running', '创建失败，正在自动清理本次自动生成的资源组', {
				resourceGroup: options.context.resourceGroup,
				vmName: options.context.vmName,
				reason: options.reason
			})
		);
		await deleteResourceGroupWithProgress(
			options.clients,
			options.context.resourceGroup,
			options.progress
		);
		await options.progress(
			createProgressEvent('cleanup-resource-group', 'success', '本次自动生成的资源组已清理完成', {
				resourceGroup: options.context.resourceGroup,
				vmName: options.context.vmName
			})
		);
		return null;
	} catch (cleanupErr) {
		const cleanupMessage = formatAzureError(cleanupErr);
		await options.progress(
			createProgressEvent('cleanup-resource-group', 'error', `自动清理资源组失败: ${cleanupMessage}`, {
				resourceGroup: options.context.resourceGroup,
				vmName: options.context.vmName
			})
		);
		return cleanupMessage;
	}
}

async function syncDnsAfterVmCreate(options: {
	userId: number;
	accountId: number;
	bindingId: number;
	result: CreateVmResult;
	progress?: (event: CreateVmProgressEvent) => void | Promise<void>;
}) {
	if (!options.bindingId) {
		await options.progress?.(createProgressEvent('dns-sync', 'info', '未选择 DNS 自动解析，跳过同步'));
		return;
	}

	const binding = await findDnsBindingByUser(options.userId, options.bindingId);
	if (!binding || !binding.enabled) {
		await options.progress?.(
			createProgressEvent('dns-sync', 'info', 'DNS 自动解析绑定不存在或已停用，跳过同步')
		);
		return;
	}
	const config = await findDnsConfigByUser(options.userId, binding.configId);
	if (!config || !config.enabled) {
		await options.progress?.(
			createProgressEvent('dns-sync', 'info', 'DNS 配置不存在或已停用，跳过同步')
		);
		return;
	}

	await options.progress?.(
		createProgressEvent('dns-sync', 'running', '同步公网 IP 到彩虹 DNS 解析', {
			binding: binding.name,
			domain: binding.domainName,
			subdomain: binding.subdomain,
			ipv4: options.result.publicIPv4,
			ipv6: options.result.publicIPv6
		})
	);

	try {
		const syncResult = await syncDnsBindingToIp(createRainbowDnsClient(config), binding, {
			ipv4: options.result.publicIPv4,
			ipv6: options.result.publicIPv6,
			vmName: options.result.name,
			resourceGroup: options.result.resourceGroup
		});

		await updateDnsBindingSyncState(options.userId, binding.id, {
			lastARecordId: syncResult.lastARecordId,
			lastAAAARecordId: syncResult.lastAAAARecordId,
			lastIpv4: syncResult.lastIpv4,
			lastIpv6: syncResult.lastIpv6,
			lastSyncedAt: new Date()
		});

		await options.progress?.(
			createProgressEvent('dns-sync', 'success', `DNS 解析已同步到 ${syncResult.fqdn}`, {
				created: syncResult.created.join(',') || '-',
				updated: syncResult.updated.join(',') || '-',
				skipped: syncResult.skipped.join(',') || '-'
			})
		);
	} catch (err) {
		await options.progress?.(
			createProgressEvent('dns-sync', 'error', err instanceof Error ? err.message : String(err), {
				binding: binding.name,
				domain: binding.domainName
			})
		);
	}
}

function createVmProgressStream(options: {
	context: StreamContext;
	clientIp: string;
	proxyMode: string;
	proxyProfileId: number | null;
	dnsBindingId: number;
	location: string;
	vmOptions: CreateVmOptions;
	cleanupResourceGroupOnFailure: boolean;
}) {
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let closed = false;

	const closeHeartbeat = () => {
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = null;
	};

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (payload: unknown) => {
				if (closed) return false;
				const ok = safeStreamMessage(controller, payload);
				if (!ok) {
					closed = true;
					closeHeartbeat();
				}
				return ok;
			};
			const progress = async (event: CreateVmProgressEvent) => {
				send({ type: 'progress', event });
				await logVmCreateEvent({ ...options.context, event });
			};

			heartbeat = setInterval(() => {
				try {
					send({ type: 'heartbeat', timestamp: new Date().toISOString() });
				} catch {
					closed = true;
					closeHeartbeat();
				}
			}, 15000);

			void (async () => {
				let clients: AzureClients | null = null;
				try {
					await progress(
						createProgressEvent('request-received', 'running', '创建请求已收到，正在连接账号和代理', {
							resourceGroup: options.context.resourceGroup,
							vmName: options.context.vmName,
							location: options.location,
							vmSize: options.vmOptions.vmSize,
							proxyMode: options.proxyMode
						})
					);

					const { account, proxy } = await getUserAccountWithSelectedProxy(
						options.context.userId,
						options.context.accountId,
						{
							clientIp: options.clientIp,
							proxyMode: options.proxyMode,
							proxyProfileId: options.proxyProfileId
						}
					);
					await progress(
						createProgressEvent('account-proxy', 'success', 'Azure 账号和代理出口已确认', {
							accountId: options.context.accountId,
							proxyMode: options.proxyMode
						})
					);

					clients = createAzureClients(account, proxy);
					const result = await createVmAdvanced(clients, {
						...options.vmOptions,
						progress
					});
					await syncDnsAfterVmCreate({
						userId: options.context.userId,
						accountId: options.context.accountId,
						bindingId: options.dnsBindingId,
						result,
						progress
					});

					send({ type: 'result', result: publicResult(result) });
				} catch (err) {
					const message = formatAzureError(err);
					const failed = createProgressEvent('failed', 'error', message);
					await logVmCreateEvent({ ...options.context, event: failed });
					send({ type: 'progress', event: failed });
					const cleanupMessage = await cleanupGeneratedResourceGroupOnFailure({
						clients,
						context: options.context,
						enabled: options.cleanupResourceGroupOnFailure,
						reason: message,
						progress
					});
					send({
						type: 'error',
						message: cleanupMessage
							? `${message}；自动清理资源组失败: ${cleanupMessage}`
							: message
					});
				} finally {
					closed = true;
					closeHeartbeat();
					try {
						controller.close();
					} catch {
						// The client may have disconnected after receiving a terminal event.
					}
				}
			})();
		},
		cancel() {
			closed = true;
			closeHeartbeat();
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'application/x-ndjson; charset=utf-8',
			'cache-control': 'no-store, no-transform',
			'x-accel-buffering': 'no',
			connection: 'keep-alive'
		}
	});
}

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const accountId = Number(body.account_id);
	const location = String(body.location ?? '').trim();
	const requestedResourceGroup = String(body.resource_group ?? '').trim();
	const requestedVmName = String(body.vm_name ?? '').trim();
	const resourceGroup = requestedResourceGroup || randomAzureResourceName('rg-azp', 64);
	const vmName = requestedVmName || randomAzureResourceName('vm-azp', 48);
	const cleanupResourceGroupOnFailure =
		!requestedResourceGroup || body.resource_group_auto_generated === true;
	const adminPassword = String(body.admin_password ?? '');
	const dnsBindingId = Number(body.dns_binding_id ?? 0);
	const proxyMode = String(body.proxy_mode ?? 'account');
	const proxyProfileId = Number(body.proxy_profile_id ?? 0) || null;
	const clientIp = getRequestClientIp(event);
	const wantsProgressStream =
		event.request.headers.get('accept')?.includes('application/x-ndjson') ?? false;

	if (!accountId || !location) return fail('参数不完整');
	if (!adminPassword) return fail('缺少管理员密码');

	const vmOptions: CreateVmOptions = {
		resourceGroup,
		location,
		vmName,
		vmSize: String(body.vm_size ?? 'Standard_B1s'),
		imageReference: String(body.image_reference ?? 'Canonical:ubuntu-24_04-lts:server:latest'),
		adminUsername: String(body.admin_username ?? 'azureuser'),
		adminPassword,
		enableIpv6: Boolean(body.enable_ipv6),
		enableAcceleratedNetworking: Boolean(body.enable_accelerated_networking),
		openPorts: String(body.open_ports ?? ''),
		enableDdosProtection: Boolean(body.enable_ddos_protection),
		customData: String(body.userdata ?? '')
	};
	const context = {
		userId: user.id,
		accountId,
		resourceGroup,
		vmName
	};

	if (wantsProgressStream) {
		return createVmProgressStream({
			context,
			clientIp,
			proxyMode,
			proxyProfileId,
			dnsBindingId,
			location,
			vmOptions,
			cleanupResourceGroupOnFailure
		});
	}

	let clients: AzureClients | null = null;
	const logProgress = (progressEvent: CreateVmProgressEvent) =>
		logVmCreateEvent({ ...context, event: progressEvent });
	try {
		const { account, proxy } = await getUserAccountWithSelectedProxy(user.id, accountId, {
			clientIp,
			proxyMode,
			proxyProfileId
		});
		clients = createAzureClients(account, proxy);
		const result = await createVmAdvanced(clients, {
			...vmOptions,
			progress: logProgress
		});
		await syncDnsAfterVmCreate({
			userId: user.id,
			accountId,
			bindingId: dnsBindingId,
			result,
			progress: logProgress
		});
		return ok(publicResult(result));
	} catch (err) {
		const message = formatAzureError(err);
		await insertExecutionLog({
			userId: user.id,
			accountId,
			source: 'vm_create',
			action: 'failed',
			status: 'error',
			message,
			resourceGroup,
			vmName
		}).catch((logErr) => console.warn('[execution-log] failed to write VM create error:', logErr));
		const cleanupMessage = await cleanupGeneratedResourceGroupOnFailure({
			clients,
			context,
			enabled: cleanupResourceGroupOnFailure,
			reason: message,
			progress: logProgress
		});
		return fail(
			cleanupMessage ? `${message}；自动清理资源组失败: ${cleanupMessage}` : message,
			500
		);
	}
};
