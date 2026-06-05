from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import build_azure_client, get_user_account
from app.azure_client import parse_vm
from app.models import User
from app.schemas import VmInfo, VmPowerRequest
from app.security import get_current_user

router = APIRouter(prefix="/api/user/azure", tags=["vms"])


@router.get("/resource/list", response_model=list[VmInfo])
async def list_vms(
    account_id: int = Query(...),
    resource_group: str | None = Query(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[VmInfo]:
    account = await get_user_account(db, user, account_id)
    client = build_azure_client(account)
    vms = await client.list_vms(resource_group)
    result: list[VmInfo] = []
    for vm in vms:
        rg = vm["id"].split("/resourceGroups/")[1].split("/")[0]
        power = await client.get_power_state(rg, vm["name"])
        parsed = parse_vm(vm, power)
        result.append(VmInfo(**parsed))
    return result


@router.post("/vm/power/on")
async def power_on(
    payload: VmPowerRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    account = await get_user_account(db, user, payload.account_id)
    client = build_azure_client(account)
    await client.start_vm(payload.resource_group, payload.vm_name)
    return {"message": f"已触发开机: {payload.vm_name}"}


@router.post("/vm/power/off")
async def power_off(
    payload: VmPowerRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    account = await get_user_account(db, user, payload.account_id)
    client = build_azure_client(account)
    await client.deallocate_vm(payload.resource_group, payload.vm_name)
    return {"message": f"已触发关机(释放): {payload.vm_name}"}


@router.post("/vm/power/restart")
async def power_restart(
    payload: VmPowerRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    account = await get_user_account(db, user, payload.account_id)
    client = build_azure_client(account)
    await client.restart_vm(payload.resource_group, payload.vm_name)
    return {"message": f"已触发重启: {payload.vm_name}"}
