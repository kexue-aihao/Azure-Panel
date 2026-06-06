import { getUserAccountWithSelectedProxy } from '$lib/server/accounts';
import { createAzureClients, deleteResourceGroupWithProgress } from '$lib/server/azure';
import { insertExecutionLog } from '$lib/server/db/repo';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

type DeleteProgressEvent = {
	step: string;
	status: 'running' | 'success' | 'error' | 'info';
	message: string;
	detail?: Record<string, string | number | boolean | null>;
	timestamp: string;
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

async function writeDeleteLog(options: {
	userId: number;
	accountId: number;
	resourceGroup: string;
	vmName: string;
	event: DeleteProgressEvent;
}) {
	await insertExecutionLog({
		userId: options.userId,
		accountId: options.accountId,
		source: 'vm_delete',
		action: options.event.step,
		status: options.event.status,
		message: options.event.message,
		resourceGroup: options.resourceGroup,
		vmName: options.vmName
	}).catch((logErr) => console.warn('[execution-log] failed to write delete log:', logErr));
}

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const accountId = Number(body.account_id);
	const resourceGroup = String(body.resource_group ?? '').trim();
	const vmName = String(body.vm_name ?? '').trim();
	if (!accountId || !resourceGroup || !vmName) return fail('参数不完整');

	const wantsProgressStream = event.request.headers
		.get('accept')
		?.includes('application/x-ndjson');

	const runDelete = async (progress?: (item: DeleteProgressEvent) => void | Promise<void>) => {
		await progress?.(
			progressEvent('delete-validate', 'success', '删除参数已确认', {
				resourceGroup,
				vmName
			})
		);
		await progress?.(progressEvent('delete-auth', 'running', '连接 Azure 账号并准备删除资源组'));
		const { account, proxy } = await getUserAccountWithSelectedProxy(user.id, accountId, {
			clientIp: getRequestClientIp(event),
			proxyMode: String(body.proxy_mode ?? 'account'),
			proxyProfileId: Number(body.proxy_profile_id ?? 0) || null
		});
		await progress?.(progressEvent('delete-auth', 'success', 'Azure 账号已连接'));
		await deleteResourceGroupWithProgress(
			createAzureClients(account, proxy),
			resourceGroup,
			progress
		);
		await progress?.(
			progressEvent('delete-complete', 'success', `已删除资源组 ${resourceGroup} 及其中全部资源`, {
				resourceGroup,
				vmName
			})
		);
		return { message: `已删除资源组 ${resourceGroup} 及其中全部资源` };
	};

	if (wantsProgressStream) {
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				const progress = async (item: DeleteProgressEvent) => {
					streamMessage(controller, { type: 'progress', event: item });
					void writeDeleteLog({
						userId: user.id,
						accountId,
						resourceGroup,
						vmName,
						event: item
					});
				};

				try {
					const result = await runDelete(progress);
					streamMessage(controller, { type: 'result', result });
				} catch (err) {
					const item = progressEvent(
						'delete-failed',
						'error',
						err instanceof Error ? err.message : String(err)
					);
					await progress(item);
					streamMessage(controller, { type: 'error', message: item.message });
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
		const result = await runDelete((item) =>
			writeDeleteLog({
				userId: user.id,
				accountId,
				resourceGroup,
				vmName,
				event: item
			})
		);
		return ok(result);
	} catch (err) {
		await insertExecutionLog({
			userId: user.id,
			accountId,
			source: 'vm_delete',
			action: 'delete-failed',
			status: 'error',
			message: err instanceof Error ? err.message : String(err),
			resourceGroup,
			vmName
		}).catch((logErr) => console.warn('[execution-log] failed to write delete log:', logErr));
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
