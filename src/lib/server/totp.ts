import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;

function base32Encode(buffer: Buffer) {
	let bits = '';
	for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
	let output = '';
	for (let i = 0; i < bits.length; i += 5) {
		const chunk = bits.slice(i, i + 5).padEnd(5, '0');
		output += BASE32_ALPHABET[parseInt(chunk, 2)];
	}
	return output;
}

function base32Decode(value: string) {
	const clean = value.toUpperCase().replace(/[^A-Z2-7]/g, '');
	let bits = '';
	for (const char of clean) {
		const index = BASE32_ALPHABET.indexOf(char);
		if (index < 0) continue;
		bits += index.toString(2).padStart(5, '0');
	}
	const bytes: number[] = [];
	for (let i = 0; i + 8 <= bits.length; i += 8) {
		bytes.push(parseInt(bits.slice(i, i + 8), 2));
	}
	return Buffer.from(bytes);
}

function hotp(secret: string, counter: number) {
	const key = base32Decode(secret);
	const buffer = Buffer.alloc(8);
	buffer.writeBigUInt64BE(BigInt(counter));
	const digest = createHmac('sha1', key).update(buffer).digest();
	const offset = digest[digest.length - 1] & 0x0f;
	const code =
		((digest[offset] & 0x7f) << 24) |
		((digest[offset + 1] & 0xff) << 16) |
		((digest[offset + 2] & 0xff) << 8) |
		(digest[offset + 3] & 0xff);
	return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

function normalizeCode(code: string) {
	return String(code ?? '').replace(/\s+/g, '');
}

export function generateTotpSecret() {
	return base32Encode(randomBytes(20));
}

export function buildTotpUri(options: { email: string; secret: string; issuer?: string }) {
	const issuer = options.issuer || 'Azure Panel';
	const label = `${issuer}:${options.email}`;
	const params = new URLSearchParams({
		secret: options.secret,
		issuer,
		algorithm: 'SHA1',
		digits: String(TOTP_DIGITS),
		period: String(TOTP_STEP_SECONDS)
	});
	return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

export function verifyTotpCode(secret: string, code: string, window = 1) {
	const cleanCode = normalizeCode(code);
	if (!/^\d{6}$/.test(cleanCode)) return false;
	const nowCounter = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
	const codeBuffer = Buffer.from(cleanCode);
	for (let offset = -window; offset <= window; offset += 1) {
		const expected = hotp(secret, nowCounter + offset);
		const expectedBuffer = Buffer.from(expected);
		if (
			codeBuffer.length === expectedBuffer.length &&
			timingSafeEqual(codeBuffer, expectedBuffer)
		) {
			return true;
		}
	}
	return false;
}
