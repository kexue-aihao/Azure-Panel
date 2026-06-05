import { runWorkflowOnce } from '$lib/server/worker';
import { ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	await requireUser(event);
	await runWorkflowOnce();
	return ok({ message: '已手动触发补机检查' });
};
