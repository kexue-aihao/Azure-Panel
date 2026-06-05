import { listAiDeployments } from '$lib/server/azure';
import { fail, ok, requireUser } from '$lib/server/http';
import { getAzureContext } from '../../../_helpers';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const accountId = event.url.searchParams.get('account_id');
	const resourceGroup = String(event.url.searchParams.get('resource_group') ?? '').trim();
	const accountName = String(event.url.searchParams.get('ai_account_name') ?? '').trim();
	if (!resourceGroup || !accountName) return fail('缺少 resource_group 或 ai_account_name');

	try {
		const { account, proxy } = await getAzureContext(event, user.id, accountId);
		const deployments = await listAiDeployments(account, proxy, resourceGroup, accountName);
		return ok(
			deployments.map((deployment) => ({
				id: deployment.id,
				name: deployment.name,
				resource_group: deployment.resourceGroup,
				account_name: deployment.accountName,
				model_format: deployment.modelFormat,
				model_name: deployment.modelName,
				model_version: deployment.modelVersion,
				scale_type: deployment.scaleType,
				capacity: deployment.capacity,
				provisioning_state: deployment.provisioningState
			}))
		);
	} catch (err) {
		return fail(String(err), 500);
	}
};
