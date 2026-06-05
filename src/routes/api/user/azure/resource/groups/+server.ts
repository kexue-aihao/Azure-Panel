import { listGenericResources, listResourceGroups } from '$lib/server/azure';
import { fail, ok, requireUser } from '$lib/server/http';
import { getAzureContext } from '../../_helpers';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const accountId = event.url.searchParams.get('account_id');
	const resourceGroup = String(event.url.searchParams.get('resource_group') ?? '').trim();
	const resourceType = String(event.url.searchParams.get('resource_type') ?? '').trim();

	try {
		const { clients, subscriptionId } = await getAzureContext(event, user.id, accountId);
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
		return fail(String(err), 500);
	}
};
