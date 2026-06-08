import { isAdminUser, normalizeUserRole } from '$lib/server/admin';
import { hashPassword, serializeUserForClient } from '$lib/server/auth';
import {
	countActiveAdminUsers,
	createManagedUser,
	deleteUserAndOwnedData,
	findUserByEmail,
	findUserById,
	listAdminUsers
} from '$lib/server/db/repo';
import { fail, ok, requireAdmin } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	await requireAdmin(event);
	const users = await listAdminUsers();
	return ok(
		users.map((user) => ({
			id: user.id,
			email: user.email,
			role: user.role,
			disabled: user.disabled,
			created_at: user.createdAt,
			account_count: user.accountCount,
			proxy_count: user.proxyCount,
			dns_config_count: user.dnsConfigCount,
			dns_binding_count: user.dnsBindingCount,
			workflow_count: user.workflowCount,
			execution_log_count: user.executionLogCount
		}))
	);
};

export const POST: RequestHandler = async (event) => {
	await requireAdmin(event);
	const body = (await event.request.json().catch(() => ({}))) as {
		email?: unknown;
		password?: unknown;
		role?: unknown;
		disabled?: unknown;
	};
	const email = String(body.email ?? '').trim().toLowerCase();
	const password = String(body.password ?? '');
	const role = normalizeUserRole(body.role);
	const disabled = Boolean(body.disabled);

	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('邮箱格式无效', 400);
	if (password.length < 6) return fail('密码至少需要 6 位', 400);
	if (await findUserByEmail(email)) return fail('邮箱已注册', 400);

	const user = await createManagedUser({
		email,
		passwordHash: await hashPassword(password),
		role,
		disabled
	});
	return ok(serializeUserForClient(user), 201);
};

export const DELETE: RequestHandler = async (event) => {
	const admin = await requireAdmin(event);
	const body = (await event.request.json().catch(() => ({}))) as { ids?: unknown };
	const ids = Array.isArray(body.ids)
		? [
				...new Set(
					body.ids
						.map((id) => Number(id))
						.filter((id) => Number.isInteger(id) && id > 0)
				)
			]
		: [];
	if (ids.length === 0) return fail('请选择要删除的用户', 400);
	if (ids.includes(admin.id)) return fail('不能删除当前登录的管理员账号', 400);

	const targets = [];
	for (const id of ids) {
		const target = await findUserById(id);
		if (!target) return fail(`用户 ID ${id} 不存在`, 404);
		targets.push(target);
	}

	const activeAdminCount = await countActiveAdminUsers();
	const activeAdminDeleteCount = targets.filter((user) => isAdminUser(user) && !user.disabled).length;
	if (activeAdminCount - activeAdminDeleteCount < 1) {
		return fail('至少需要保留一个可用管理员账号', 400);
	}

	for (const target of targets) {
		await deleteUserAndOwnedData(target.id);
	}
	return ok({ deleted_ids: ids, deleted_count: ids.length });
};
