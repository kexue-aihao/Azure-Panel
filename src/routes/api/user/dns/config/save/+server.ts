import { encryptSecret } from '$lib/server/crypto';
import {
	findDnsConfigByUser,
	insertDnsConfig,
	updateDnsConfig
} from '$lib/server/db/repo';
import { publicDnsConfig } from '$lib/server/dns';
import { fail, ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

function normalizeBaseUrl(value: string) {
	return value.trim().replace(/\/+$/, '');
}

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const id = Number(body.id ?? 0);
	const name = String(body.name ?? '').trim();
	const baseUrl = normalizeBaseUrl(String(body.base_url ?? ''));
	const uid = Number(body.uid ?? 0);
	const apiKey = String(body.api_key ?? '').trim();
	const enabled = body.enabled !== false;

	if (!name || !baseUrl || !uid) return fail('请填写 DNS 配置名称、面板地址和 UID');
	if (!/^https?:\/\//i.test(baseUrl)) return fail('彩虹 DNS 面板地址必须以 http:// 或 https:// 开头');

	try {
		if (id) {
			const existing = await findDnsConfigByUser(user.id, id);
			if (!existing) return fail('DNS 配置不存在', 404);
			const updated = await updateDnsConfig(user.id, id, {
				name,
				baseUrl,
				uid,
				enabled,
				...(apiKey ? { apiKeyEncrypted: encryptSecret(apiKey) } : {})
			});
			if (!updated) return fail('DNS 配置保存失败', 500);
			return ok(publicDnsConfig(updated));
		}

		if (!apiKey) return fail('新增 DNS 配置必须填写 API Key');
		const created = await insertDnsConfig({
			userId: user.id,
			name,
			baseUrl,
			uid,
			apiKeyEncrypted: encryptSecret(apiKey),
			enabled
		});
		return ok(publicDnsConfig(created));
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};

export const PUT: RequestHandler = async (event) => POST(event);

export const PATCH: RequestHandler = async (event) => POST(event);
