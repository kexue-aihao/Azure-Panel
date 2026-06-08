import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { error } from '@sveltejs/kit';
import { isAdminUser } from './admin';
import { getSecretKey } from './env';
import { createUser, findUserByEmail, findUserById } from './db/repo';
import type { User } from './db/schema';

const TOKEN_TTL = '7d';

export async function hashPassword(password: string): Promise<string> {
	return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
	return bcrypt.compare(password, hash);
}

export async function createToken(user: User): Promise<string> {
	const secret = new TextEncoder().encode(getSecretKey());
	return new SignJWT({ email: user.email, role: user.role })
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject(String(user.id))
		.setExpirationTime(TOKEN_TTL)
		.sign(secret);
}

export async function getUserFromAuthHeader(authHeader: string | null): Promise<User> {
	if (!authHeader?.startsWith('Bearer ')) {
		error(401, '未登录');
	}

	const token = authHeader.slice(7);
	let userId = 0;
	try {
		const secret = new TextEncoder().encode(getSecretKey());
		const { payload } = await jwtVerify(token, secret);
		userId = Number(payload.sub);
		if (!Number.isInteger(userId) || userId <= 0) error(401, '登录已失效');
	} catch {
		error(401, '登录已失效');
	}

	const row = await findUserById(userId);
	if (!row) error(401, '用户不存在');
	if (row.disabled) error(403, '账号已被管理员禁用');
	return row;
}

export function serializeUserForClient(user: User) {
	return {
		id: user.id,
		email: user.email,
		role: user.role,
		is_admin: isAdminUser(user),
		disabled: Boolean(user.disabled),
		totp_enabled: Boolean(user.totpEnabled)
	};
}

export async function registerUser(email: string, password: string): Promise<User> {
	const normalizedEmail = email.trim().toLowerCase();
	const existing = await findUserByEmail(normalizedEmail);
	if (existing) error(400, '邮箱已注册');

	const passwordHash = await hashPassword(password);
	return createUser(normalizedEmail, passwordHash);
}

export async function loginUser(email: string, password: string): Promise<User> {
	const user = await findUserByEmail(email.trim().toLowerCase());
	if (!user || !(await verifyPassword(password, user.passwordHash))) {
		error(401, '邮箱或密码错误');
	}
	if (user.disabled) error(403, '账号已被管理员禁用');
	return user;
}
