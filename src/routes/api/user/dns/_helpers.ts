import type { DnsConfig } from '$lib/server/db/schema';
import {
	findDnsConfigByUser,
	listDnsConfigsByUser
} from '$lib/server/db/repo';
import { createRainbowDnsClient } from '$lib/server/dns';

export function numberParam(value: string | null, fallback = 0) {
	const number = Number(value);
	return Number.isFinite(number) ? number : fallback;
}

export async function getUserDnsConfig(userId: number, configId: number): Promise<DnsConfig> {
	const config = configId
		? await findDnsConfigByUser(userId, configId)
		: (await listDnsConfigsByUser(userId)).find((item) => item.enabled);
	if (!config) throw new Error('DNS 配置不存在或无权访问');
	if (!config.enabled) throw new Error('DNS 配置已停用');
	return config;
}

export async function getUserDnsClient(userId: number, configId: number) {
	const config = await getUserDnsConfig(userId, configId);
	return {
		config,
		client: createRainbowDnsClient(config)
	};
}
