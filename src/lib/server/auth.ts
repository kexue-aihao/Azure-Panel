import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { error } from '@sveltejs/kit';
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
	return new SignJWT({ email: user.email })
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
	try {
		const secret = new TextEncoder().encode(getSecretKey());
		const { payload } = await jwtVerify(token, secret);
		const userId = Number(payload.sub);
		if (!Number.isInteger(userId) || userId <= 0) error(401, '登录已失效');

		const row = await findUserById(userId);
		if (!row) error(401, '用户不存在');
		return row;
	} catch {
		error(401, '登录已失效');
	}
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
	return user;
}
