import { createRainbowDnsClient, RainbowDnsClient } from '$lib/server/dns';
import { fail, ok, requireUser } from '$lib/server/http';
import { getUserDnsConfig } from '../../_helpers';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const configId = Number(body.config_id ?? 0);
	const baseUrl = String(body.base_url ?? '').trim();
	const username = String(body.username ?? '').trim();
	const password = String(body.password ?? '').trim();

	try {
		const client =
			configId && !password
				? createRainbowDnsClient(await getUserDnsConfig(user.id, configId))
				: new RainbowDnsClient({ baseUrl, username, password });

		const result = await client.listDomains({ limit: 1 });
		return ok({ ok: true, total: result.total });
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
