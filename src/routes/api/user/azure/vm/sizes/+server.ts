import { getUserAccount } from '$lib/server/accounts';
import { fallbackVmCapabilities, listVmCapabilities } from '$lib/server/azure';
import { fail, ok, requireUser } from '$lib/server/http';
import { getVmQueryContext } from '../_helpers';
import type { RequestHandler } from './$types';

type VmCapabilities = Awaited<ReturnType<typeof listVmCapabilities>>;

function shouldUseFastFallback(value: string | null) {
	return ['1', 'true', 'yes'].includes((value ?? '').trim().toLowerCase());
}

function toSizesResponse(result: VmCapabilities) {
	return {
		location: result.location,
		sizes: result.available.map((size) => ({
			name: size.name,
			cores: size.cores,
			memory_mb: Math.round(size.memoryGB * 1024),
			memory_gb: size.memoryGB,
			max_data_disk_count: size.maxDataDiskCount,
			accelerated_networking: size.acceleratedNetworking,
			hyper_v_generations: size.hyperVGenerations,
			quota_name: size.quotaName,
			quota_localized_name: size.quotaLocalizedName,
			quota_remaining: size.quotaRemaining,
			quota_required: size.quotaRequired,
			source: size.source
		})),
		restricted: result.restricted
	};
}

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);

	try {
		const fast = shouldUseFastFallback(event.url.searchParams.get('fast'));
		const accountId = Number(event.url.searchParams.get('account_id') ?? event.url.searchParams.get('account'));
		const requestedLocation = String(event.url.searchParams.get('location') ?? '').trim();
		if (fast && requestedLocation) {
			if (!accountId) return fail('缺少 account_id');
			await getUserAccount(user.id, accountId);
			return ok(toSizesResponse(fallbackVmCapabilities(requestedLocation)));
		}

		const { clients, location } = await getVmQueryContext(event, user.id);
		const result = await listVmCapabilities(clients, location, { includeQuotas: false });
		return ok(toSizesResponse(result));
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
