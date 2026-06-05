import { encryptSecret } from '$lib/server/crypto';
import { insertProxyProfile } from '$lib/server/db/repo';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import {
	normalizeManagedCore,
	startManagedProxyFromShareLink,
	type ManagedProxyCore
} from '$lib/server/managed-proxy-core';
import {
	CLIENT_IP_PROXY_HOST,
	normalizeProxyRuntime,
	parseProxyShareLink,
	publicProxyProfile,
	validateProxyConnection
} from '$lib/server/proxy';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();

	const shareLink = String(body.share_link ?? '').trim();
	const parsedShareLink = shareLink ? parseProxyShareLink(shareLink) : null;
	if (parsedShareLink && !parsedShareLink.supported) {
		return fail(parsedShareLink.message);
	}
	const requestedCore = normalizeManagedCore(String(body.managed_core ?? parsedShareLink?.managed_core ?? ''));
	const managedCore: ManagedProxyCore | null = parsedShareLink?.managed_supported
		? requestedCore ?? 'sing-box'
		: null;

	const requestedName = String(body.name ?? '').trim();
	const parsedName = String(parsedShareLink?.name ?? '').trim();
	const name = requestedName || parsedName;
	if (!name) return fail('请填写代理名称');

	let proxy;
	try {
		if (managedCore && shareLink) {
			proxy = await startManagedProxyFromShareLink(shareLink, { core: managedCore });
		} else {
			proxy = parsedShareLink?.proxy ?? normalizeProxyRuntime({
				type: String(body.type ?? ''),
				host:
					String(body.source ?? '') === 'client_ip'
						? CLIENT_IP_PROXY_HOST
						: String(body.host ?? ''),
				port: body.port,
				username: String(body.username ?? ''),
				password: String(body.password ?? ''),
				method: String(body.method ?? '')
			});
		}
		await validateProxyConnection(proxy, { clientIp: getRequestClientIp(event) });
	} catch (err) {
		return fail(err instanceof Error ? err.message : '代理配置无效');
	}

	const profile = await insertProxyProfile({
		userId: user.id,
		name,
		type: proxy.type,
		host: proxy.host,
		port: proxy.port,
		usernameEncrypted: proxy.method
			? encryptSecret(proxy.method)
			: proxy.username
				? encryptSecret(proxy.username)
				: '',
		passwordEncrypted: proxy.password ? encryptSecret(proxy.password) : '',
		managedCore: managedCore ?? '',
		shareLinkEncrypted: managedCore && shareLink ? encryptSecret(shareLink) : ''
	});

	return ok(publicProxyProfile(profile));
};
