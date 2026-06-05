import { error } from '@sveltejs/kit';
import { findAccountByUser, findProxyProfileByUser, listAccountsByUser } from './db/repo';
import type { AzureAccount, User } from './db/schema';
import { proxyProfileToRuntime, type ProxyRuntimeConfig } from './proxy';

export type AzureAccountWithProxy = {
	account: AzureAccount;
	proxy: ProxyRuntimeConfig | null;
};

export async function getUserAccount(userId: number, accountId: number): Promise<AzureAccount> {
	const account = await findAccountByUser(userId, accountId);
	if (!account) error(404, 'Azure 账号不存在');
	return account;
}

export async function getUserAccountWithProxy(
	userId: number,
	accountId: number
): Promise<AzureAccountWithProxy> {
	const account = await getUserAccount(userId, accountId);
	if (!account.proxyProfileId) return { account, proxy: null };

	const profile = await findProxyProfileByUser(userId, account.proxyProfileId);
	return { account, proxy: profile ? proxyProfileToRuntime(profile) : null };
}

export async function listUserAccounts(user: User) {
	return listAccountsByUser(user.id);
}
