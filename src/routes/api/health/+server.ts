import { ok } from '$lib/server/http';
import { getDriver } from '$lib/server/db';
import { findUserById } from '$lib/server/db/repo';

async function probeDatabase(timeoutMs = 3000) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			findUserById(0),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error('database probe timeout')), timeoutMs);
			})
		]);
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err)
		};
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function GET() {
	const database = await probeDatabase();
	return ok({
		status: database.ok ? 'ok' : 'degraded',
		database: getDriver(),
		database_ok: database.ok,
		database_error: database.ok ? undefined : database.error
	}, database.ok ? 200 : 503);
}
