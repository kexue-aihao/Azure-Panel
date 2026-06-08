import { getUserAccountWithSelectedProxy } from '$lib/server/accounts';
import { brushVmPublicIPv4Prefix, createAzureClients } from '$lib/server/azure';
import {
	findDnsBindingByUser,
	findDnsConfigByUser,
	updateDnsBindingSyncState
} from '$lib/server/db/repo';
import { createRainbowDnsClient, syncDnsBindingToIp } from '$lib/server/dns';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import {
	type VmOperationProgress,
	operationProgressEvent,
	vmOperationStream,
	wantsProgressStream,
	writeVmOperationLog
} from '$lib/server/vm-operation-progress';
import type { RequestHandler } from './$types';

type BrushIpPublicResult = {
	vm_name: string;
	resource_group: string;
	public_ipv4: string;
	old_public_ipv4: string;
	public_ip_name: string;
	target_prefix: string;
	attempts: number;
	matched: boolean;
	dns_sync?: BrushIpDnsSyncResult | null;
};

type BrushIpDnsSyncResult = {
	synced: boolean;
	fqdn: string;
	message: string;
	created: string[];
	updated: string[];
	skipped: string[];
};

function bindingFqdn(binding: { domainName: string; subdomain: string }) {
	const subdomain = String(binding.subdomain ?? '').trim();
	const domain = String(binding.domainName ?? '').trim();
	if (!subdomain || subdomain === '@') return domain;
	return `${subdomain}.${domain}`;
}

function publicResult(
	result: Awaited<ReturnType<typeof brushVmPublicIPv4Prefix>>,
	dnsSync?: BrushIpDnsSyncResult | null
): BrushIpPublicResult {
	return {
		vm_name: result.vmName,
		resource_group: result.resourceGroup,
		public_ipv4: result.publicIPv4,
		old_public_ipv4: result.oldPublicIPv4,
		public_ip_name: result.publicIpName,
		target_prefix: result.targetPrefix,
		attempts: result.attempts,
		matched: result.matched,
		dns_sync: dnsSync ?? null
	};
}

async function syncDnsAfterBrush(options: {
	userId: number;
	bindingId: number;
	result: Awaited<ReturnType<typeof brushVmPublicIPv4Prefix>>;
	progress?: VmOperationProgress;
}): Promise<BrushIpDnsSyncResult | null> {
	if (!options.bindingId) {
		await options.progress?.(operationProgressEvent('dns-sync', 'info', '未选择 DNS 自动解析，跳过同步'));
		return null;
	}
	if (!options.result.publicIPv4) {
		await options.progress?.(operationProgressEvent('dns-sync', 'info', '刷 IP 完成但未返回 IPv4，跳过 DNS 同步'));
		return {
			synced: false,
			fqdn: '',
			message: '未返回 IPv4',
			created: [],
			updated: [],
			skipped: ['A: no IPv4']
		};
	}
	if (options.result.targetPrefix && !options.result.matched) {
		await options.progress?.(
			operationProgressEvent('dns-sync', 'info', '刷 IP 未命中目标前缀，跳过 DNS 同步', {
				ipv4: options.result.publicIPv4,
				targetPrefix: options.result.targetPrefix
			})
		);
		return {
			synced: false,
			fqdn: '',
			message: `未命中目标前缀 ${options.result.targetPrefix}`,
			created: [],
			updated: [],
			skipped: ['prefix not matched']
		};
	}

	const binding = await findDnsBindingByUser(options.userId, options.bindingId);
	if (!binding || !binding.enabled) {
		await options.progress?.(operationProgressEvent('dns-sync', 'info', 'DNS 绑定不存在或已停用，跳过同步'));
		return {
			synced: false,
			fqdn: '',
			message: 'DNS 绑定不存在或已停用',
			created: [],
			updated: [],
			skipped: ['binding unavailable']
		};
	}
	const config = await findDnsConfigByUser(options.userId, binding.configId);
	if (!config || !config.enabled) {
		await options.progress?.(operationProgressEvent('dns-sync', 'info', 'DNS 配置不存在或已停用，跳过同步'));
		return {
			synced: false,
			fqdn: bindingFqdn(binding),
			message: 'DNS 配置不存在或已停用',
			created: [],
			updated: [],
			skipped: ['config unavailable']
		};
	}

	await options.progress?.(
		operationProgressEvent('dns-sync', 'running', '同步刷到的 IPv4 到彩虹 DNS 解析', {
			binding: binding.name,
			domain: binding.domainName,
			subdomain: binding.subdomain,
			ipv4: options.result.publicIPv4,
			matched: options.result.matched,
			targetPrefix: options.result.targetPrefix
		})
	);

	try {
		const syncResult = await syncDnsBindingToIp(createRainbowDnsClient(config), binding, {
			ipv4: options.result.publicIPv4,
			vmName: options.result.vmName,
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
			operationProgressEvent('dns-sync', 'success', `DNS 解析已同步到 ${syncResult.fqdn}`, {
				ipv4: syncResult.lastIpv4,
				created: syncResult.created.join(',') || '-',
				updated: syncResult.updated.join(',') || '-',
				skipped: syncResult.skipped.join(',') || '-'
			})
		);
		return {
			synced: true,
			fqdn: syncResult.fqdn,
			message: `DNS 解析已同步到 ${syncResult.fqdn}`,
			created: syncResult.created,
			updated: syncResult.updated,
			skipped: syncResult.skipped
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await options.progress?.(
			operationProgressEvent('dns-sync', 'error', `DNS 同步失败: ${message}`, {
				binding: binding.name,
				domain: binding.domainName,
				ipv4: options.result.publicIPv4
			})
		);
		return {
			synced: false,
			fqdn: bindingFqdn(binding),
			message,
			created: [],
			updated: [],
			skipped: ['sync failed']
		};
	}
}

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const accountId = Number(body.account_id);
	const resourceGroup = String(body.resource_group ?? '').trim();
	const vmName = String(body.vm_name ?? '').trim();
	const ipPrefix = String(body.ip_prefix ?? '').trim();
	const dnsBindingId = Number(body.dns_binding_id ?? 0) || 0;
	if (!accountId || !resourceGroup || !vmName || !ipPrefix) return fail('参数不完整');

	try {
		const { account, proxy } = await getUserAccountWithSelectedProxy(user.id, accountId, {
			clientIp: getRequestClientIp(event),
			proxyMode: String(body.proxy_mode ?? 'account'),
			proxyProfileId: Number(body.proxy_profile_id ?? 0) || null
		});

		if (wantsProgressStream(event.request)) {
			return vmOperationStream({
				errorStep: 'brush-ip-failed',
				onProgress: (progressEvent) =>
					writeVmOperationLog({
						userId: user.id,
						accountId,
						source: 'vm_ip',
						resourceGroup,
						vmName,
						event: progressEvent
					}),
				run: async (progress) => {
					await progress(
						operationProgressEvent('brush-ip-auth', 'success', 'Azure 账号已连接，准备刷 IPv4 段', {
							resourceGroup,
							vmName,
							ipPrefix
						})
					);
					const result = await brushVmPublicIPv4Prefix(createAzureClients(account, proxy), {
						resourceGroup,
						vmName,
						ipPrefix,
						maxAttempts: Number(body.max_attempts ?? 30),
						progress
					});
					const dnsSync = await syncDnsAfterBrush({
						userId: user.id,
						bindingId: dnsBindingId,
						result,
						progress
					});
					return publicResult(result, dnsSync);
				}
			});
		}

		const result = await brushVmPublicIPv4Prefix(createAzureClients(account, proxy), {
			resourceGroup,
			vmName,
			ipPrefix,
			maxAttempts: Number(body.max_attempts ?? 30)
		});
		const dnsSync = await syncDnsAfterBrush({
			userId: user.id,
			bindingId: dnsBindingId,
			result
		});
		return ok(publicResult(result, dnsSync));
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
