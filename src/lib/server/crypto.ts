import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { getEncryptionKey } from './env';

function deriveKey(): Buffer {
	return createHash('sha256').update(getEncryptionKey()).digest();
}

export function encryptSecret(plain: string): string {
	if (!plain) return '';
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv);
	const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptSecret(payload: string): string {
	if (!payload) return '';
	const data = Buffer.from(payload, 'base64');
	const iv = data.subarray(0, 12);
	const tag = data.subarray(12, 28);
	const encrypted = data.subarray(28);
	const decipher = createDecipheriv('aes-256-gcm', deriveKey(), iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
