import { listComputeQuotas } from '$lib/server/azure';
import { fail, ok, requireUser } from '$lib/server/http';
import { getVmQueryContext } from '../_helpers';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);

	try {
		const { clients, location } = await getVmQueryContext(event, user.id);
		return ok({ quotas: await listComputeQuotas(clients, location) });
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
