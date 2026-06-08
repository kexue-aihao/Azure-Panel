import { ok, requireUser } from '$lib/server/http';
import { buildTotpUri, generateTotpSecret } from '$lib/server/totp';
import QRCode from 'qrcode';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const secret = generateTotpSecret();
	const otpauthUri = buildTotpUri({ email: user.email, secret });
	return ok({
		secret,
		otpauth_uri: otpauthUri,
		qr_data_url: await QRCode.toDataURL(otpauthUri, {
			margin: 1,
			width: 220,
			errorCorrectionLevel: 'M'
		})
	});
};
