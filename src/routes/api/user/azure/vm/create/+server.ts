import { getUserAccountWithSelectedProxy } from '$lib/server/accounts';
import {
	createAzureClients,
	createVmAdvanced,
	randomAzureResourceName,
	type CreateVmProgressEvent,
	type CreateVmOptions,
	type CreateVmResult
} from '$lib/server/azure';
import { insertExecutionLog } from '$lib/server/db/repo';
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

async function logVmCreateEvent(options: {
	userId: number;
	accountId: number;
	resourceGroup: string;
	vmName: string;
	event: CreateVmProgressEvent;
}) {
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

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const accountId = Number(body.account_id);
	const location = String(body.location ?? '').trim();
	const requestedResourceGroup = String(body.resource_group ?? '').trim();
	const requestedVmName = String(body.vm_name ?? '').trim();
	const resourceGroup = requestedResourceGroup || randomAzureResourceName('rg-azp', 64);
	const vmName = requestedVmName || randomAzureResourceName('vm-azp', 48);
	const adminPassword = String(body.admin_password ?? '');

	if (!accountId || !location) return fail('参数不完整');
	if (!adminPassword) return fail('缺少管理员密码');

	try {
		const { account, proxy } = await getUserAccountWithSelectedProxy(user.id, accountId, {
			clientIp: getRequestClientIp(event),
			proxyMode: String(body.proxy_mode ?? 'account'),
			proxyProfileId: Number(body.proxy_profile_id ?? 0) || null
		});
		const vmOptions: CreateVmOptions = {
			resourceGroup,
			location,
			vmName,
			vmSize: String(body.vm_size ?? 'Standard_B1s'),
			imageReference: String(body.image_reference ?? 'Canonical:ubuntu-24_04-lts:server:latest'),
			adminUsername: String(body.admin_username ?? 'azureuser'),
			adminPassword,
			enableIpv6: Boolean(body.enable_ipv6),
			openPorts: String(body.open_ports ?? ''),
			enableDdosProtection: Boolean(body.enable_ddos_protection),
			customData: String(body.userdata ?? ''),
			ipPrefix: String(body.ip_prefix ?? ''),
			ipBrushMaxAttempts: Number(body.ip_brush_max_attempts ?? 30)
		};
		const wantsProgressStream = event.request.headers
			.get('accept')
			?.includes('application/x-ndjson');

		if (wantsProgressStream) {
			const stream = new ReadableStream<Uint8Array>({
				async start(controller) {
					const progress = async (progressEvent: CreateVmProgressEvent) => {
						await logVmCreateEvent({
							userId: user.id,
							accountId,
							resourceGroup,
							vmName,
							event: progressEvent
						});
						streamMessage(controller, { type: 'progress', event: progressEvent });
					};

					try {
						const result = await createVmAdvanced(createAzureClients(account, proxy), {
							...vmOptions,
							progress
						});
						streamMessage(controller, { type: 'result', result: publicResult(result) });
					} catch (err) {
						await insertExecutionLog({
							userId: user.id,
							accountId,
							source: 'vm_create',
							action: 'failed',
							status: 'error',
							message: err instanceof Error ? err.message : String(err),
							resourceGroup,
							vmName
						}).catch((logErr) =>
							console.warn('[execution-log] failed to write VM create stream error:', logErr)
						);
						streamMessage(controller, {
							type: 'error',
							message: err instanceof Error ? err.message : String(err)
						});
					} finally {
						controller.close();
					}
				}
			});

			return new Response(stream, {
				headers: {
					'content-type': 'application/x-ndjson; charset=utf-8',
					'cache-control': 'no-store'
				}
			});
		}

		const result = await createVmAdvanced(createAzureClients(account, proxy), {
			...vmOptions,
			progress: (progressEvent) =>
				logVmCreateEvent({
					userId: user.id,
					accountId,
					resourceGroup,
					vmName,
					event: progressEvent
				})
		});
		return ok(publicResult(result));
	} catch (err) {
		await insertExecutionLog({
			userId: user.id,
			accountId,
			source: 'vm_create',
			action: 'failed',
			status: 'error',
			message: err instanceof Error ? err.message : String(err),
			resourceGroup,
			vmName
		}).catch((logErr) => console.warn('[execution-log] failed to write VM create error:', logErr));
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
