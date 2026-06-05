import { deleteProxyProfile, findProxyProfileByUser } from '$lib/server/db/repo';
import { fail, ok, requireUser } from '$lib/server/http';
import { stopManagedProxyForProfile } from '$lib/server/managed-proxy-core';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const proxyProfileId = Number(event.url.searchParams.get('proxy_id'));
	if (!proxyProfileId) return fail('缺少 proxy_id');

	const profile = await findProxyProfileByUser(user.id, proxyProfileId);
	if (!profile) return fail('代理配置不存在', 404);

	await stopManagedProxyForProfile(profile);
	await deleteProxyProfile(user.id, proxyProfileId);
	return ok({ message: '已删除代理配置' });
};
