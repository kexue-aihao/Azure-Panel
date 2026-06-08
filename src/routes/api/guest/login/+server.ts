import { isHttpError } from '@sveltejs/kit';
import { createToken, loginUser, serializeUserForClient } from '$lib/server/auth';
import { decryptSecret } from '$lib/server/crypto';
import { fail, ok } from '$lib/server/http';
import { verifyTotpCode } from '$lib/server/totp';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const email = String(body.email ?? '');
	const password = String(body.password ?? '');
	const totpCode = String(body.totp_code ?? body.totpCode ?? '').trim();
	if (!email || !password) return fail('邮箱和密码不能为空');

	try {
		const user = await loginUser(email, password);
		if (user.totpEnabled) {
			if (!totpCode) {
				return ok({
					requires_2fa: true,
					message: '请输入二步验证码'
				});
			}
			const secret = decryptSecret(user.totpSecretEncrypted ?? '');
			if (!secret || !verifyTotpCode(secret, totpCode)) {
				return fail('二步验证码错误或已过期', 401);
			}
		}
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
		if (isHttpError(err)) return fail(String(err.body?.message ?? '登录失败'), err.status);
		return fail('登录失败', 401);
	}
};
