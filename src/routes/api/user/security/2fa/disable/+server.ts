import { verifyPassword } from '$lib/server/auth';
import { decryptSecret } from '$lib/server/crypto';
import { updateUserSecurityFields } from '$lib/server/db/repo';
import { fail, ok, requireUser } from '$lib/server/http';
import { verifyTotpCode } from '$lib/server/totp';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const password = String(body.password ?? '');
	const code = String(body.code ?? body.totp_code ?? '').trim();
	if (!password) return fail('请输入当前登录密码');
	if (!(await verifyPassword(password, user.passwordHash))) return fail('当前密码错误', 401);

	if (user.totpEnabled) {
		const secret = decryptSecret(user.totpSecretEncrypted ?? '');
		if (!secret || !verifyTotpCode(secret, code)) return fail('二步验证码错误或已过期', 401);
	}

	await updateUserSecurityFields(user.id, {
		totpEnabled: false,
		totpSecretEncrypted: ''
	});
	return ok({ enabled: false });
};
