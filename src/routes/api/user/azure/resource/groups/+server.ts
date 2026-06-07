import {
	deleteResourceGroupWithProgress,
	formatAzureError,
	listGenericResources,
	listResourceGroups
} from '$lib/server/azure';
import { insertExecutionLog } from '$lib/server/db/repo';
import { fail, ok, requireUser } from '$lib/server/http';
import { getAzureContext } from '../../_helpers';
import type { RequestHandler } from './$types';

type DeleteProgressEvent = {
	step: string;
	status: 'running' | 'success' | 'error' | 'info';
	message: string;
	detail?: Record<string, string | number | boolean | null>;
	timestamp: string;
};

type DeleteResult = {
	resource_group: string;
	status: 'success' | 'error';
	message: string;
};

function progressEvent(
	step: string,
	status: DeleteProgressEvent['status'],
	message: string,
	detail?: DeleteProgressEvent['detail']
): DeleteProgressEvent {
	return {
		step,
		status,
		message,
		detail,
		timestamp: new Date().toISOString()
	};
}

function streamMessage(controller: ReadableStreamDefaultController<Uint8Array>, payload: unknown) {
	controller.enqueue(new TextEncoder().encode(`${JSON.stringify(payload)}\n`));
}

function normalizeResourceGroups(value: unknown) {
	const input = Array.isArray(value) ? value : [value];
	return [...new Set(input.map((item) => String(item ?? '').trim()).filter(Boolean))].slice(0, 50);
}

function isReadonlyResourceAuthorizationError(err: unknown) {
	const message = formatAzureError(err);
	return (
		/AuthorizationFailed/i.test(message) &&
		/Microsoft\.Resources\/subscriptions\/(?:resourcegroups|resources)\/read/i.test(message)
	);
}

async function writeDeleteLog(options: {
	userId: number;
	accountId: number;
	resourceGroup: string;
	event: DeleteProgressEvent;
}) {
	await insertExecutionLog({
		userId: options.userId,
		accountId: options.accountId,
		source: 'resource_group_delete',
		action: options.event.step,
		status: options.event.status,
		message: options.event.message,
		resourceGroup: options.resourceGroup,
		vmName: ''
	}).catch((logErr) => console.warn('[execution-log] failed to write resource group delete log:', logErr));
}

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const accountId = event.url.searchParams.get('account_id');
	const resourceGroup = String(event.url.searchParams.get('resource_group') ?? '').trim();
	const resourceType = String(event.url.searchParams.get('resource_type') ?? '').trim();
	let subscriptionId = '';

	try {
		const context = await getAzureContext(event, user.id, accountId);
		const clients = context.clients;
		subscriptionId = context.subscriptionId;
		const [groups, resources] = await Promise.all([
			listResourceGroups(clients),
			listGenericResources(clients, resourceGroup || undefined, resourceType || undefined)
		]);
		return ok({
			subscription_id: subscriptionId,
			groups: groups.map((group) => ({
				id: group.id,
				name: group.name,
				location: group.location,
				provisioning_state: group.provisioningState
			})),
			resources: resources.map((resource) => ({
				id: resource.id,
				name: resource.name,
				type: resource.type,
				location: resource.location,
				resource_group: resource.resourceGroup,
				kind: resource.kind,
				sku_name: resource.skuName,
				provisioning_state: resource.provisioningState
			}))
		});
	} catch (err) {
		if (isReadonlyResourceAuthorizationError(err)) {
			return ok({
				subscription_id: subscriptionId,
				groups: [],
				resources: [],
				warning:
					'当前账号没有读取资源组/资源列表的 IAM 权限，已跳过资源浏览。可手动填写资源组和区域继续创建 Foundry / Azure AI 资源。'
			});
		}
		return fail(String(err), 500);
	}
};

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const accountId = Number(body.account_id);
	const resourceGroups = normalizeResourceGroups(body.resource_groups ?? body.resource_group);
	if (!accountId || resourceGroups.length === 0) return fail('参数不完整');

	const wantsProgressStream = event.request.headers
		.get('accept')
		?.includes('application/x-ndjson');

	const runDelete = async (progress?: (item: DeleteProgressEvent) => void | Promise<void>) => {
		const { clients, subscriptionId } = await getAzureContext(
			event,
			user.id,
			accountId,
			body.subscription_id
		);
		await progress?.(
			progressEvent('batch-prepare', 'success', `已连接 Azure，准备删除 ${resourceGroups.length} 个资源组`, {
				subscriptionId,
				total: resourceGroups.length
			})
		);

		await progress?.(
			progressEvent('batch-submit', 'running', `正在并发提交 ${resourceGroups.length} 个资源组删除请求`, {
				mode: 'parallel',
				total: resourceGroups.length
			})
		);

		const results = await Promise.all(
			resourceGroups.map(async (resourceGroup, index): Promise<DeleteResult> => {
				const report = async (item: DeleteProgressEvent) => {
					const detail = {
						...(item.detail ?? {}),
						resourceGroup,
						index: index + 1,
						total: resourceGroups.length
					};
					const eventWithGroup = { ...item, detail };
					await progress?.(eventWithGroup);
					await writeDeleteLog({
						userId: user.id,
						accountId,
						resourceGroup,
						event: eventWithGroup
					});
				};

				try {
					await report(
						progressEvent('delete-group-start', 'running', `开始删除资源组 ${resourceGroup}`, {
							resourceGroup
						})
					);
					await deleteResourceGroupWithProgress(clients, resourceGroup, report);
					const message = `资源组 ${resourceGroup} 已删除`;
					await report(progressEvent('delete-group-complete', 'success', message, { resourceGroup }));
					return { resource_group: resourceGroup, status: 'success', message };
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					await report(
						progressEvent('delete-group-failed', 'error', `资源组 ${resourceGroup} 删除失败: ${message}`, {
							resourceGroup
						})
					);
					return { resource_group: resourceGroup, status: 'error', message };
				}
			})
		);

		const success = results.filter((item) => item.status === 'success').length;
		const failed = results.length - success;
		await progress?.(
			progressEvent('batch-complete', failed ? 'info' : 'success', `资源组批量删除完成：成功 ${success} 个，失败 ${failed} 个`, {
				success,
				failed,
				total: results.length
			})
		);
		return { results, success, failed };
	};

	if (wantsProgressStream) {
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				try {
					const result = await runDelete((item) => streamMessage(controller, { type: 'progress', event: item }));
					streamMessage(controller, { type: 'result', result });
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					streamMessage(controller, { type: 'error', message });
				} finally {
					controller.close();
				}
			}
		});

		return new Response(stream, {
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8',
				'cache-control': 'no-store',
				'x-accel-buffering': 'no'
			}
		});
	}

	try {
		return ok(await runDelete());
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
