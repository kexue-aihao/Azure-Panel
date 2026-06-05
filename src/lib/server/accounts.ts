import { error } from '@sveltejs/kit';
import { ensureClientIpProxyProfile } from './auto-client-ip-proxy';
import { DIRECT_PROXY, type AzureProxySelection } from './azure';
import { findAccountByUser, findProxyProfileByUser, listAccountsByUser } from './db/repo';
import type { AzureAccount, User } from './db/schema';
import { proxyProfileToRuntimeReady, type ProxyRuntimeConfig } from './proxy';

export type AzureAccountWithProxy = {
	account: AzureAccount;
	proxy: ProxyRuntimeConfig | null;
};

export type AzureAccountWithSelectedProxy = {
	account: AzureAccount;
	proxy: AzureProxySelection;
};

export async function getUserAccount(userId: number, accountId: number): Promise<AzureAccount> {
	const account = await findAccountByUser(userId, accountId);
	if (!account) error(404, 'Azure 账号不存在');
	return account;
}

export async function getUserAccountWithProxy(
	userId: number,
	accountId: number,
	options: { clientIp?: string } = {}
): Promise<AzureAccountWithProxy> {
	const account = await getUserAccount(userId, accountId);
	if (!account.proxyProfileId) return { account, proxy: null };

	const profile = await findProxyProfileByUser(userId, account.proxyProfileId);
	return { account, proxy: profile ? await proxyProfileToRuntimeReady(profile, options) : null };
}

export async function getUserAccountWithSelectedProxy(
	userId: number,
	accountId: number,
	options: {
		clientIp?: string;
		proxyMode?: string | null;
		proxyProfileId?: number | null;
	} = {}
): Promise<AzureAccountWithSelectedProxy> {
	const mode = (options.proxyMode ?? 'account').trim();
	if (!mode || mode === 'account') return getUserAccountWithProxy(userId, accountId, options);

	const account = await getUserAccount(userId, accountId);
	if (mode === 'direct') return { account, proxy: DIRECT_PROXY };

	if (mode === 'client_ip') {
		const profile = await ensureClientIpProxyProfile(userId, options.clientIp ?? '');
		return { account, proxy: await proxyProfileToRuntimeReady(profile, options) };
	}

	if (mode === 'profile') {
		const profileId = Number(options.proxyProfileId ?? 0);
		if (!profileId) throw new Error('缺少 proxy_profile_id');
		const profile = await findProxyProfileByUser(userId, profileId);
		if (!profile) throw new Error('代理配置不存在');
		return { account, proxy: await proxyProfileToRuntimeReady(profile, options) };
	}

	throw new Error('代理选择无效');
}

export async function listUserAccounts(user: User) {
	return listAccountsByUser(user.id);
}
