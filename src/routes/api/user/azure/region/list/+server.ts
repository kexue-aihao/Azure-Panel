import { getUserAccount, getUserAccountWithSelectedProxy } from '$lib/server/accounts';
import {
	createAzureClients,
	fallbackAvailableVmRegions,
	listAvailableVmRegions,
	type AzureRegionOption
} from '$lib/server/azure';
import { updateAccountRegionCache } from '$lib/server/db/repo';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

function shouldRefreshCache(value: string | null) {
	return ['1', 'true', 'yes', 'force'].includes((value ?? '').trim().toLowerCase());
}

function shouldUseFastFallback(value: string | null) {
	return ['1', 'true', 'yes'].includes((value ?? '').trim().toLowerCase());
}

function parseRegionCache(raw: string | null | undefined): AzureRegionOption[] | null {
	if (!raw?.trim()) return null;

	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed) || parsed.length === 0) return null;
		const regions = parsed
			.map((item) => {
				if (!item || typeof item !== 'object') return null;
				const region = item as Partial<AzureRegionOption>;
				const name = String(region.name ?? '').trim();
				if (!name) return null;
				return {
					name,
					displayName: String(region.displayName || name),
					availableSizeCount: Number(region.availableSizeCount) || 0,
					highestCoreSize: region.highestCoreSize ?? null,
					largestMemorySize: region.largestMemorySize ?? null
				} satisfies AzureRegionOption;
			})
			.filter((region): region is AzureRegionOption => region !== null);
		return regions.length > 0 ? regions : null;
	} catch {
		return null;
	}
}

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const accountId = Number(event.url.searchParams.get('account_id'));
	if (!accountId) return fail('缺少 account_id');

	try {
		const refresh = shouldRefreshCache(event.url.searchParams.get('refresh'));
		const cachedAccount = await getUserAccount(user.id, accountId);
		const cachedRegions = parseRegionCache(cachedAccount.vmRegionCache);
		if (!refresh && cachedRegions) return ok(cachedRegions);
		if (!refresh && shouldUseFastFallback(event.url.searchParams.get('fast'))) {
			return ok(fallbackAvailableVmRegions());
		}

		const { account, proxy } = await getUserAccountWithSelectedProxy(user.id, accountId, {
			clientIp: getRequestClientIp(event),
			proxyMode: event.url.searchParams.get('proxy_mode'),
			proxyProfileId: Number(event.url.searchParams.get('proxy_profile_id') ?? 0) || null
		});
		const regions = await listAvailableVmRegions(createAzureClients(account, proxy));
		if (regions.length > 0) {
			await updateAccountRegionCache(user.id, accountId, JSON.stringify(regions));
		}
		return ok(regions);
	} catch (err) {
		const cachedAccount = await getUserAccount(user.id, accountId).catch(() => null);
		const cachedRegions = parseRegionCache(cachedAccount?.vmRegionCache);
		return ok(cachedRegions?.length ? cachedRegions : fallbackAvailableVmRegions());
	}
};
