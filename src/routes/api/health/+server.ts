import { ok } from '$lib/server/http';

export function GET() {
	return ok({ status: 'ok' });
}
