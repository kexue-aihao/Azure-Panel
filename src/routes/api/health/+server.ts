import { ok } from '$lib/server/http';
import { getDriver } from '$lib/server/db';
import { getStartupStatus } from '$lib/server/startup-state';

export async function GET() {
	const startup = getStartupStatus();
	const ready = startup.phase === 'ready';
	return ok({
		status: ready ? 'ok' : startup.phase,
		database: getDriver(),
		ready,
		startup
	}, ready ? 200 : 503);
}
