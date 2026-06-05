import { runWorkflowOnceForUser } from '$lib/server/worker';
import { ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	await runWorkflowOnceForUser(user.id, { force: true });
	return ok({ message: '已手动触发当前用户的补机检查' });
};
