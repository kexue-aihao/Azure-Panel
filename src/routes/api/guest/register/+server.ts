import { isHttpError } from '@sveltejs/kit';
import { createToken, registerUser, serializeUserForClient } from '$lib/server/auth';
import { fail, ok } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const email = String(body.email ?? '').trim().toLowerCase();
	const password = String(body.password ?? '');
	if (!email || password.length < 6) return fail('邮箱无效或密码少于 6 位');

	try {
		const user = await registerUser(email, password);
		const token = await createToken(user);
		const clientUser = serializeUserForClient(user);
		return ok({
			token,
			email: user.email,
			role: clientUser.role,
			is_admin: clientUser.is_admin,
			user: clientUser
		});
	} catch (err) {
		if (isHttpError(err)) return fail(String(err.body?.message ?? '注册失败'), err.status);
		console.error('[register] failed', err);
		return fail(err instanceof Error ? `注册失败: ${err.message}` : '注册失败', 500);
	}
};
