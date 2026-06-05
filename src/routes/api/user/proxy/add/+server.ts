import { encryptSecret } from '$lib/server/crypto';
import { insertProxyProfile } from '$lib/server/db/repo';
import { fail, ok, requireUser } from '$lib/server/http';
import { normalizeProxyRuntime, publicProxyProfile } from '$lib/server/proxy';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();

	const name = String(body.name ?? '').trim();
	if (!name) return fail('请填写代理名称');

	let proxy;
	try {
		proxy = normalizeProxyRuntime({
			type: String(body.type ?? ''),
			host: String(body.host ?? ''),
			port: body.port,
			username: String(body.username ?? ''),
			password: String(body.password ?? '')
		});
	} catch (err) {
		return fail(err instanceof Error ? err.message : '代理配置无效');
	}

	const profile = await insertProxyProfile({
		userId: user.id,
		name,
		type: proxy.type,
		host: proxy.host,
		port: proxy.port,
		usernameEncrypted: proxy.username ? encryptSecret(proxy.username) : '',
		passwordEncrypted: proxy.password ? encryptSecret(proxy.password) : ''
	});

	return ok(publicProxyProfile(profile));
};
