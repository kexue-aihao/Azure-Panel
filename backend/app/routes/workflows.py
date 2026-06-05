import json

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import get_user_account
from app.models import User, WorkflowLog, WorkflowPolicy
from app.schemas import WorkflowCreate, WorkflowLogResponse, WorkflowResponse, WorkflowUpdate
from app.security import encrypt_secret, get_current_user
from app.worker import workflow_worker

router = APIRouter(prefix="/api/user", tags=["workflows"])


def _to_response(policy: WorkflowPolicy) -> WorkflowResponse:
    return WorkflowResponse(
        id=policy.id,
        account_id=policy.account_id,
        name=policy.name,
        enabled=policy.enabled,
        resource_group=policy.resource_group,
        location=policy.location,
        vm_names=json.loads(policy.vm_names or "[]"),
        min_running_count=policy.min_running_count,
        auto_start=policy.auto_start,
        auto_create=policy.auto_create,
        vm_size=policy.vm_size,
        image_reference=policy.image_reference,
        name_prefix=policy.name_prefix,
        admin_username=policy.admin_username,
        check_interval_seconds=policy.check_interval_seconds,
        last_run_at=policy.last_run_at,
        created_at=policy.created_at,
    )


@router.get("/workflow/list", response_model=list[WorkflowResponse])
async def list_workflows(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[WorkflowResponse]:
    result = await db.execute(select(WorkflowPolicy).where(WorkflowPolicy.user_id == user.id))
    return [_to_response(p) for p in result.scalars().all()]


@router.post("/workflow/add", response_model=WorkflowResponse)
async def add_workflow(
    payload: WorkflowCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> WorkflowResponse:
    await get_user_account(db, user, payload.account_id)
    policy = WorkflowPolicy(
        user_id=user.id,
        account_id=payload.account_id,
        name=payload.name,
        enabled=payload.enabled,
        resource_group=payload.resource_group,
        location=payload.location,
        vm_names=json.dumps(payload.vm_names),
        min_running_count=payload.min_running_count,
        auto_start=payload.auto_start,
        auto_create=payload.auto_create,
        vm_size=payload.vm_size,
        image_reference=payload.image_reference,
        name_prefix=payload.name_prefix,
        admin_username=payload.admin_username,
        admin_password_encrypted=encrypt_secret(payload.admin_password),
        check_interval_seconds=payload.check_interval_seconds,
    )
    db.add(policy)
    await db.commit()
    await db.refresh(policy)
    return _to_response(policy)


@router.put("/workflow/{policy_id}", response_model=WorkflowResponse)
async def update_workflow(
    policy_id: int,
    payload: WorkflowUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> WorkflowResponse:
    result = await db.execute(
        select(WorkflowPolicy).where(WorkflowPolicy.id == policy_id, WorkflowPolicy.user_id == user.id)
    )
    policy = result.scalar_one_or_none()
    if policy is None:
        raise HTTPException(status_code=404, detail="工作流不存在")

    data = payload.model_dump(exclude_unset=True)
    if "vm_names" in data and data["vm_names"] is not None:
        data["vm_names"] = json.dumps(data["vm_names"])
    if "admin_password" in data:
        password = data.pop("admin_password")
        if password:
            policy.admin_password_encrypted = encrypt_secret(password)

    for key, value in data.items():
        setattr(policy, key, value)

    await db.commit()
    await db.refresh(policy)
    return _to_response(policy)


@router.delete("/workflow/{policy_id}")
async def delete_workflow(
    policy_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    result = await db.execute(
        select(WorkflowPolicy).where(WorkflowPolicy.id == policy_id, WorkflowPolicy.user_id == user.id)
    )
    policy = result.scalar_one_or_none()
    if policy is None:
        raise HTTPException(status_code=404, detail="工作流不存在")
    await db.delete(policy)
    await db.commit()
    return {"message": "已删除"}


@router.post("/workflow/run")
async def run_workflows_now(user: User = Depends(get_current_user)) -> dict[str, str]:
    _ = user
    await workflow_worker.run_once()
    return {"message": "已手动触发补机检查"}


@router.get("/workflow/logs", response_model=list[WorkflowLogResponse])
async def list_workflow_logs(
    policy_id: int | None = Query(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[WorkflowLogResponse]:
    query = (
        select(WorkflowLog)
        .join(WorkflowPolicy, WorkflowLog.policy_id == WorkflowPolicy.id)
        .where(WorkflowPolicy.user_id == user.id)
        .order_by(WorkflowLog.id.desc())
        .limit(100)
    )
    if policy_id is not None:
        query = query.where(WorkflowLog.policy_id == policy_id)

    result = await db.execute(query)
    logs = result.scalars().all()
    return [
        WorkflowLogResponse(
            id=log.id,
            policy_id=log.policy_id,
            action=log.action,
            status=log.status,
            message=log.message,
            created_at=log.created_at,
        )
        for log in logs
    ]
