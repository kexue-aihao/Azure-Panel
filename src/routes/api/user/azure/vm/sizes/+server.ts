import { listVmCapabilities } from '$lib/server/azure';
import { fail, ok, requireUser } from '$lib/server/http';
import { getVmQueryContext } from '../_helpers';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);

	try {
		const { clients, location } = await getVmQueryContext(event, user.id);
		const result = await listVmCapabilities(clients, location);
		return ok({
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
		});
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
