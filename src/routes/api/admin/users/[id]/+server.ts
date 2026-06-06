import { isAdminUser, normalizeUserRole } from '$lib/server/admin';
import { serializeUserForClient } from '$lib/server/auth';
import {
	countActiveAdminUsers,
	deleteUserAndOwnedData,
	findUserById,
	updateUserAdminFields
} from '$lib/server/db/repo';
import { fail, ok, requireAdmin } from '$lib/server/http';
import type { RequestHandler } from './$types';

function isLastActiveAdmin(target: Awaited<ReturnType<typeof findUserById>>, activeAdminCount: number) {
	return Boolean(target && isAdminUser(target) && !target.disabled && activeAdminCount <= 1);
}

export const PUT: RequestHandler = async (event) => {
	const admin = await requireAdmin(event);
	const targetId = Number(event.params.id);
	if (!Number.isInteger(targetId) || targetId <= 0) return fail('用户 ID 无效', 400);

	const target = await findUserById(targetId);
	if (!target) return fail('用户不存在', 404);

	const body = (await event.request.json().catch(() => ({}))) as {
		role?: unknown;
		disabled?: unknown;
	};
	const updates: { role?: string; disabled?: boolean } = {};

	if (body.role !== undefined) {
		const role = String(body.role).trim().toLowerCase();
		if (role !== 'admin' && role !== 'user') return fail('用户角色无效', 400);
		updates.role = normalizeUserRole(role);
	}
	if (body.disabled !== undefined) {
		updates.disabled = Boolean(body.disabled);
	}
	if (Object.keys(updates).length === 0) return fail('没有需要更新的字段', 400);

	if (target.id === admin.id) {
		if (updates.disabled === true) return fail('不能禁用当前登录的管理员账号', 400);
		if (updates.role && updates.role !== 'admin') return fail('不能降级当前登录的管理员账号', 400);
	}

	const activeAdminCount = await countActiveAdminUsers();
	if (isLastActiveAdmin(target, activeAdminCount)) {
		if (updates.disabled === true || updates.role === 'user') {
			return fail('至少需要保留一个可用管理员账号', 400);
		}
	}

	const updated = await updateUserAdminFields(target.id, updates);
	if (!updated) return fail('用户不存在', 404);
	return ok(serializeUserForClient(updated));
};

export const DELETE: RequestHandler = async (event) => {
	const admin = await requireAdmin(event);
	const targetId = Number(event.params.id);
	if (!Number.isInteger(targetId) || targetId <= 0) return fail('用户 ID 无效', 400);

	const target = await findUserById(targetId);
	if (!target) return fail('用户不存在', 404);
	if (target.id === admin.id) return fail('不能删除当前登录的管理员账号', 400);

	const activeAdminCount = await countActiveAdminUsers();
	if (isLastActiveAdmin(target, activeAdminCount)) {
		return fail('至少需要保留一个可用管理员账号', 400);
	}

	await deleteUserAndOwnedData(target.id);
	return ok({ message: '用户已删除' });
};
