import { createAiDeployment } from '$lib/server/azure';
import { fail, ok, requireUser } from '$lib/server/http';
import { getAzureContext } from '../../../_helpers';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const resourceGroup = String(body.resource_group ?? '').trim();
	const accountName = String(body.ai_account_name ?? '').trim();
	const deploymentName = String(body.deployment_name ?? '').trim();
	const modelName = String(body.model_name ?? '').trim();
	if (!resourceGroup || !accountName || !deploymentName || !modelName) return fail('参数不完整');

	try {
		const { account, proxy } = await getAzureContext(
			event,
			user.id,
			body.account_id,
			body.subscription_id
		);
		const deployment = await createAiDeployment(account, proxy, {
			resourceGroup,
			accountName,
			deploymentName,
			modelName,
			modelFormat: String(body.model_format ?? 'OpenAI').trim() || 'OpenAI',
			modelVersion: String(body.model_version ?? '').trim(),
			scaleType: String(body.scale_type ?? 'Standard').trim() || 'Standard',
			capacity: Number(body.capacity ?? 1)
		});
		return ok({
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
		});
	} catch (err) {
		return fail(String(err), 500);
	}
};
