import { encryptSecret } from '$lib/server/crypto';
import { updateUserSecurityFields } from '$lib/server/db/repo';
import { fail, ok, requireUser } from '$lib/server/http';
import { verifyTotpCode } from '$lib/server/totp';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const secret = String(body.secret ?? '').trim().toUpperCase();
	const code = String(body.code ?? body.totp_code ?? '').trim();
	if (!secret || !code) return fail('请先生成密钥并输入二步验证码');
	if (!verifyTotpCode(secret, code)) return fail('二步验证码错误或已过期', 400);

	await updateUserSecurityFields(user.id, {
		totpEnabled: true,
		totpSecretEncrypted: encryptSecret(secret)
	});
	return ok({ enabled: true });
};
