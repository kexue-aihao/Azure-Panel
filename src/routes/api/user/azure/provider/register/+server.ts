import { DEFAULT_PROVIDER_NAMESPACES, registerResourceProviders } from '$lib/server/azure';
import { fail, ok, requireUser } from '$lib/server/http';
import { getAzureContext } from '../../_helpers';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const namespaces = Array.isArray(body.namespaces)
		? body.namespaces.map(String).filter(Boolean)
		: DEFAULT_PROVIDER_NAMESPACES;

	try {
		const { clients, subscriptionId } = await getAzureContext(
			event,
			user.id,
			body.account_id,
			body.subscription_id
		);
		return ok({
			subscription_id: subscriptionId,
			providers: await registerResourceProviders(clients, namespaces)
		});
	} catch (err) {
		return fail(String(err), 500);
	}
};
