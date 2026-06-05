import { isHttpError } from '@sveltejs/kit';
import { createToken, loginUser } from '$lib/server/auth';
import { fail, ok } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const email = String(body.email ?? '');
	const password = String(body.password ?? '');
	if (!email || !password) return fail('邮箱和密码不能为空');

	try {
		const user = await loginUser(email, password);
		const token = await createToken(user);
		return ok({ token, email: user.email });
	} catch (err) {
		if (isHttpError(err)) return fail(String(err.body?.message ?? '登录失败'), err.status);
		return fail('登录失败', 401);
	}
};
