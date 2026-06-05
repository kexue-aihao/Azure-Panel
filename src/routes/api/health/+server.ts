import { ok } from '$lib/server/http';
import { getDriver } from '$lib/server/db';
import { findUserById } from '$lib/server/db/repo';

export async function GET() {
	await findUserById(0);
	return ok({ status: 'ok', database: getDriver() });
}
