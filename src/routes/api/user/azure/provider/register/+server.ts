import { getUserAccount } from '$lib/server/accounts';
import { DEFAULT_PROVIDER_NAMESPACES, registerResourceProviders } from '$lib/server/azure';
import {
	canCacheProviderStatuses,
	mergeProviderStatusCache,
	parseProviderStatusCache
} from '$lib/server/azure-provider-cache';
import { updateAccountProviderCache } from '$lib/server/db/repo';
import { fail, ok, requireUser } from '$lib/server/http';
import {
	operationProgressEvent,
	vmOperationStream,
	wantsProgressStream,
	type VmOperationProgress
} from '$lib/server/vm-operation-progress';
import { getAzureContext } from '../../_helpers';
import type { RequestHandler } from './$types';

async function registerProvidersWithCache(options: {
	event: Parameters<RequestHandler>[0];
	userId: number;
	body: Record<string, unknown>;
	namespaces: string[];
	progress?: VmOperationProgress;
}) {
	await options.progress?.(
		operationProgressEvent('provider-prepare', 'running', '准备注册常用 Azure Provider', {
			total: options.namespaces.length
		})
	);

	const { clients, subscriptionId } = await getAzureContext(
		options.event,
		options.userId,
		options.body.account_id,
		options.body.subscription_id
	);
	await options.progress?.(
		operationProgressEvent('provider-auth', 'success', 'Azure 账号和订阅已确认', {
			subscriptionId
		})
	);

	const providers = await registerResourceProviders(clients, options.namespaces, options.progress);
	if (canCacheProviderStatuses(providers)) {
		await options.progress?.(
			operationProgressEvent('provider-cache', 'running', '正在写入 Provider 状态缓存')
		);
		const numericAccountId = Number(options.body.account_id);
		const account = await getUserAccount(options.userId, numericAccountId);
		const cache = parseProviderStatusCache(account.vmProviderCache);
		await updateAccountProviderCache(
			options.userId,
			numericAccountId,
			JSON.stringify(mergeProviderStatusCache(cache, subscriptionId, providers))
		);
		await options.progress?.(
			operationProgressEvent('provider-cache', 'success', 'Provider 状态缓存已更新')
		);
	}

	await options.progress?.(
		operationProgressEvent('provider-complete', 'success', '常用 Provider 注册流程完成', {
			registered: providers.filter((provider) =>
				(provider.registrationState || '').toLowerCase().includes('registered')
			).length,
			total: providers.length
		})
	);

	return {
		subscription_id: subscriptionId,
		providers
	};
}

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const namespaces = Array.isArray(body.namespaces)
		? body.namespaces.map(String).filter(Boolean)
		: DEFAULT_PROVIDER_NAMESPACES;

	try {
		if (wantsProgressStream(event.request)) {
			return vmOperationStream({
				errorStep: 'provider-failed',
				run: (progress) =>
					registerProvidersWithCache({
						event,
						userId: user.id,
						body,
						namespaces,
						progress
					})
			});
		}

		return ok(await registerProvidersWithCache({
			event,
			userId: user.id,
			body,
			namespaces
		}));
	} catch (err) {
		return fail(String(err), 500);
	}
};
