import { error, json, type RequestEvent } from '@sveltejs/kit';
import { isAdminUser } from './admin';
import { getUserFromAuthHeader } from './auth';

export function ok<T>(data: T, status = 200) {
	return json(data, { status });
}

export function fail(message: string, status = 400) {
	return json({ message }, { status });
}

export async function requireUser(event: RequestEvent) {
	return getUserFromAuthHeader(event.request.headers.get('authorization'));
}

export async function requireAdmin(event: RequestEvent) {
	const user = await requireUser(event);
	if (!isAdminUser(user)) error(403, '需要管理员权限');
	return user;
}

function firstHeaderIp(value: string | null) {
	return value
		?.split(',')
		.map((item) => item.trim())
		.find(Boolean);
}

export function getRequestClientIp(event: RequestEvent) {
	const headers = event.request.headers;
	const forwarded =
		firstHeaderIp(headers.get('cf-connecting-ip')) ??
		firstHeaderIp(headers.get('x-real-ip')) ??
		firstHeaderIp(headers.get('x-forwarded-for'));
	const raw = forwarded ?? event.getClientAddress();
	return raw.trim().replace(/^\[(.*)\]$/, '$1').replace(/^::ffff:/, '');
}
