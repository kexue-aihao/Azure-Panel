import { getUserAccount } from '$lib/server/accounts';
import { deleteAccount } from '$lib/server/db/repo';
import { ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const accountId = Number(event.url.searchParams.get('account_id'));
	await getUserAccount(user.id, accountId);
	await deleteAccount(accountId);
	return ok({ message: '已删除' });
};
