import { json, type RequestEvent } from '@sveltejs/kit';
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
