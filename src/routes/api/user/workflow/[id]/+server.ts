import { encryptSecret } from '$lib/server/crypto';
import { deleteWorkflow, findWorkflowByUser, updateWorkflow } from '$lib/server/db/repo';
import { fail, ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const policyId = Number(event.params.id);
	const policy = await findWorkflowByUser(user.id, policyId);
	if (!policy) return fail('工作流不存在', 404);

	const body = await event.request.json();
	const updates: Record<string, unknown> = {};

	if (body.name !== undefined) updates.name = String(body.name);
	if (body.resource_group !== undefined) updates.resourceGroup = String(body.resource_group);
	if (body.location !== undefined) updates.location = String(body.location);
	if (body.vm_names !== undefined) updates.vmNamesJson = JSON.stringify(body.vm_names);
	if (body.min_running_count !== undefined) updates.minRunningCount = Number(body.min_running_count);
	if (body.auto_start !== undefined) updates.autoStart = Boolean(body.auto_start);
	if (body.auto_create !== undefined) updates.autoCreate = Boolean(body.auto_create);
	if (body.vm_size !== undefined) updates.vmSize = String(body.vm_size);
	if (body.image_reference !== undefined) updates.imageReference = String(body.image_reference);
	if (body.name_prefix !== undefined) updates.namePrefix = String(body.name_prefix);
	if (body.admin_username !== undefined) updates.adminUsername = String(body.admin_username);
	if (body.check_interval_seconds !== undefined)
		updates.checkIntervalSeconds = Number(body.check_interval_seconds);
	if (body.enabled !== undefined) updates.enabled = Boolean(body.enabled);
	if (body.admin_password) updates.adminPasswordEncrypted = encryptSecret(String(body.admin_password));

	const updated = await updateWorkflow(policyId, updates);
	return ok({ id: updated?.id, enabled: updated?.enabled, name: updated?.name });
};

export const DELETE: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const policyId = Number(event.params.id);
	const policy = await findWorkflowByUser(user.id, policyId);
	if (!policy) return fail('工作流不存在', 404);
	await deleteWorkflow(policyId);
	return ok({ message: '已删除' });
};
