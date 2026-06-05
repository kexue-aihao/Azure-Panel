from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.azure_client import RUNNING_STATES, AzureClient, AzureCredentials
from app.config import get_settings
from app.database import SessionLocal
from app.models import AzureAccount, WorkflowLog, WorkflowPolicy
from app.security import decrypt_secret

logger = logging.getLogger(__name__)
settings = get_settings()


class WorkflowWorker:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._stop.clear()
            self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            await self._task

    async def _loop(self) -> None:
        logger.info("自动补机工作流已启动")
        while not self._stop.is_set():
            try:
                await self.run_once()
            except Exception:
                logger.exception("工作流轮询失败")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=settings.worker_interval_seconds)
            except TimeoutError:
                pass

    async def run_once(self) -> None:
        async with SessionLocal() as db:
            result = await db.execute(
                select(WorkflowPolicy)
                .where(WorkflowPolicy.enabled.is_(True))
                .options(selectinload(WorkflowPolicy.account))
            )
            policies = result.scalars().all()
            for policy in policies:
                if not self._should_run(policy):
                    continue
                try:
                    await self._execute_policy(db, policy)
                    policy.last_run_at = datetime.now(UTC)
                    await db.commit()
                except Exception as exc:
                    await db.rollback()
                    await self._log(db, policy.id, "policy_error", "failed", str(exc))
                    await db.commit()
                    logger.exception("执行策略 %s 失败", policy.name)

    def _should_run(self, policy: WorkflowPolicy) -> bool:
        if policy.last_run_at is None:
            return True
        elapsed = (datetime.now(UTC) - policy.last_run_at.replace(tzinfo=UTC)).total_seconds()
        return elapsed >= policy.check_interval_seconds

    async def _execute_policy(self, db, policy: WorkflowPolicy) -> None:
        account = policy.account
        if account is None:
            raise RuntimeError("策略关联的 Azure 账号不存在")

        creds = AzureCredentials(
            tenant_id=account.tenant_id,
            client_id=account.client_id,
            client_secret=decrypt_secret(account.client_secret_encrypted),
            subscription_id=account.subscription_id,
        )
        client = AzureClient(creds)
        vm_names = json.loads(policy.vm_names or "[]")
        vms = await client.list_vms(policy.resource_group)
        vm_map = {vm["name"]: vm for vm in vms}

        tracked = [name for name in vm_names if name in vm_map] if vm_names else list(vm_map.keys())
        running = 0
        stopped: list[str] = []

        for name in tracked:
            state = await client.get_power_state(policy.resource_group, name)
            if state in RUNNING_STATES:
                running += 1
            else:
                stopped.append(name)

        await self._log(
            db,
            policy.id,
            "inspect",
            "success",
            f"资源组 {policy.resource_group}: 运行中 {running}/{len(tracked)}, 停止 {len(stopped)}",
        )

        if policy.auto_start:
            for name in stopped:
                try:
                    await client.start_vm(policy.resource_group, name)
                    await self._log(db, policy.id, "auto_start", "success", f"已触发开机: {name}")
                    running += 1
                except Exception as exc:
                    await self._log(db, policy.id, "auto_start", "failed", f"开机失败 {name}: {exc}")

        deficit = max(policy.min_running_count - running, 0)
        if deficit <= 0 or not policy.auto_create:
            return

        admin_password = decrypt_secret(policy.admin_password_encrypted)
        if not admin_password:
            await self._log(db, policy.id, "auto_create", "failed", "未配置管理员密码，无法自动补机")
            return

        for index in range(deficit):
            vm_name = f"{policy.name_prefix}-{int(datetime.now(UTC).timestamp())}-{index}"
            try:
                await client.create_vm_simple(
                    resource_group=policy.resource_group,
                    location=policy.location,
                    vm_name=vm_name,
                    vm_size=policy.vm_size,
                    image_reference=policy.image_reference,
                    admin_username=policy.admin_username,
                    admin_password=admin_password,
                )
                await self._log(db, policy.id, "auto_create", "success", f"已创建并部署 VM: {vm_name}")
            except Exception as exc:
                await self._log(db, policy.id, "auto_create", "failed", f"补机失败 {vm_name}: {exc}")

    async def _log(self, db, policy_id: int, action: str, status: str, message: str) -> None:
        db.add(WorkflowLog(policy_id=policy_id, action=action, status=status, message=message))


workflow_worker = WorkflowWorker()
