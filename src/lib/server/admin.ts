import type { User } from './db/schema';
import { readEnv } from './runtime-env';

export const USER_ROLE = 'user';
export const ADMIN_ROLE = 'admin';

export type UserRole = typeof USER_ROLE | typeof ADMIN_ROLE;

export function normalizeUserRole(value: unknown): UserRole {
	return String(value ?? '').toLowerCase() === ADMIN_ROLE ? ADMIN_ROLE : USER_ROLE;
}

export function isAdminUser(user: Pick<User, 'role'> | null | undefined): boolean {
	return normalizeUserRole(user?.role) === ADMIN_ROLE;
}

export function getConfiguredAdminEmails(): string[] {
	const raw = [
		readEnv('AZURE_PANEL_ADMIN_EMAILS'),
		readEnv('AZURE_PANEL_ADMIN_EMAIL'),
		readEnv('ADMIN_EMAILS'),
		readEnv('ADMIN_EMAIL')
	]
		.filter(Boolean)
		.join(',');

	return [
		...new Set(
			raw
				.split(/[,\s;]+/)
				.map((item) => item.trim().toLowerCase())
				.filter(Boolean)
		)
	];
}

export function isConfiguredAdminEmail(email: string): boolean {
	const normalized = email.trim().toLowerCase();
	return getConfiguredAdminEmails().includes(normalized);
}
