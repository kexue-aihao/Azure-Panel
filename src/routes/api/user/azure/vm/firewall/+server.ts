import { getUserAccountWithSelectedProxy } from '$lib/server/accounts';
import {
	createAzureClients,
	deleteVmFirewallRule,
	listVmFirewallRules,
	upsertVmFirewallRule
} from '$lib/server/azure';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import {
	operationProgressEvent,
	vmOperationStream,
	wantsProgressStream,
	writeVmOperationLog
} from '$lib/server/vm-operation-progress';
import type { RequestHandler } from './$types';

function proxyProfileId(value: unknown) {
	return Number(value ?? 0) || null;
}

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const accountId = Number(event.url.searchParams.get('account_id'));
	const resourceGroup = String(event.url.searchParams.get('resource_group') ?? '').trim();
	const vmName = String(event.url.searchParams.get('vm_name') ?? '').trim();
	if (!accountId || !resourceGroup || !vmName) return fail('参数不完整');

	try {
		const { account, proxy } = await getUserAccountWithSelectedProxy(user.id, accountId, {
			clientIp: getRequestClientIp(event),
			proxyMode: event.url.searchParams.get('proxy_mode'),
			proxyProfileId: proxyProfileId(event.url.searchParams.get('proxy_profile_id'))
		});

		if (wantsProgressStream(event.request)) {
			return vmOperationStream({
				errorStep: 'firewall-list-failed',
				onProgress: (progressEvent) =>
					writeVmOperationLog({
						userId: user.id,
						accountId,
						source: 'vm_firewall',
						resourceGroup,
						vmName,
						event: progressEvent
					}),
				run: async (progress) => {
					await progress(
						operationProgressEvent('firewall-auth', 'success', 'Azure 账号已连接，准备读取防火墙策略', {
							resourceGroup,
							vmName
						})
					);
					return listVmFirewallRules(createAzureClients(account, proxy), resourceGroup, vmName, progress);
				}
			});
		}

		return ok(await listVmFirewallRules(createAzureClients(account, proxy), resourceGroup, vmName));
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const accountId = Number(body.account_id);
	const resourceGroup = String(body.resource_group ?? '').trim();
	const vmName = String(body.vm_name ?? '').trim();
	if (!accountId || !resourceGroup || !vmName || !String(body.destination_port_range ?? '').trim()) {
		return fail('参数不完整');
	}

	try {
		const { account, proxy } = await getUserAccountWithSelectedProxy(user.id, accountId, {
			clientIp: getRequestClientIp(event),
			proxyMode: String(body.proxy_mode ?? 'account'),
			proxyProfileId: proxyProfileId(body.proxy_profile_id)
		});
		const input = {
			name: String(body.name ?? ''),
			description: String(body.description ?? ''),
			protocol: String(body.protocol ?? '*'),
			sourcePortRange: String(body.source_port_range ?? '*'),
			destinationPortRange: String(body.destination_port_range ?? ''),
			sourceAddressPrefix: String(body.source_address_prefix ?? '*'),
			destinationAddressPrefix: String(body.destination_address_prefix ?? '*'),
			access: String(body.access ?? 'Allow'),
			priority: Number(body.priority ?? 1000),
			direction: String(body.direction ?? 'Inbound')
		};

		if (wantsProgressStream(event.request)) {
			return vmOperationStream({
				errorStep: 'firewall-save-failed',
				onProgress: (progressEvent) =>
					writeVmOperationLog({
						userId: user.id,
						accountId,
						source: 'vm_firewall',
						resourceGroup,
						vmName,
						event: progressEvent
					}),
				run: async (progress) => {
					await progress(
						operationProgressEvent('firewall-auth', 'success', 'Azure 账号已连接，准备保存防火墙规则', {
							resourceGroup,
							vmName
						})
					);
					return upsertVmFirewallRule(
						createAzureClients(account, proxy),
						resourceGroup,
						vmName,
						input,
						progress
					);
				}
			});
		}

		const rule = await upsertVmFirewallRule(createAzureClients(account, proxy), resourceGroup, vmName, input);
		return ok(rule);
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};

export const DELETE: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json().catch(() => ({}));
	const accountId = Number(body.account_id ?? event.url.searchParams.get('account_id'));
	const resourceGroup = String(body.resource_group ?? event.url.searchParams.get('resource_group') ?? '').trim();
	const vmName = String(body.vm_name ?? event.url.searchParams.get('vm_name') ?? '').trim();
	const ruleName = String(body.rule_name ?? event.url.searchParams.get('rule_name') ?? '').trim();
	if (!accountId || !resourceGroup || !vmName || !ruleName) return fail('参数不完整');

	try {
		const { account, proxy } = await getUserAccountWithSelectedProxy(user.id, accountId, {
			clientIp: getRequestClientIp(event),
			proxyMode: String(body.proxy_mode ?? event.url.searchParams.get('proxy_mode') ?? 'account'),
			proxyProfileId: proxyProfileId(
				body.proxy_profile_id ?? event.url.searchParams.get('proxy_profile_id')
			)
		});

		if (wantsProgressStream(event.request)) {
			return vmOperationStream({
				errorStep: 'firewall-delete-failed',
				onProgress: (progressEvent) =>
					writeVmOperationLog({
						userId: user.id,
						accountId,
						source: 'vm_firewall',
						resourceGroup,
						vmName,
						event: progressEvent
					}),
				run: async (progress) => {
					await progress(
						operationProgressEvent('firewall-auth', 'success', 'Azure 账号已连接，准备删除防火墙规则', {
							resourceGroup,
							vmName,
							ruleName
						})
					);
					return deleteVmFirewallRule(
						createAzureClients(account, proxy),
						resourceGroup,
						vmName,
						ruleName,
						progress
					);
				}
			});
		}

		return ok(
			await deleteVmFirewallRule(createAzureClients(account, proxy), resourceGroup, vmName, ruleName)
		);
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
