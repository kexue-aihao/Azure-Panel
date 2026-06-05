import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.azure_client import AzureClient, AzureCredentials
from app.deps import get_user_account
from app.models import AzureAccount, User
from app.schemas import AccountCreate, AccountResponse
from app.security import encrypt_secret, get_current_user

router = APIRouter(prefix="/api/user/azure/account", tags=["accounts"])


@router.get("/list", response_model=list[AccountResponse])
async def list_accounts(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[AccountResponse]:
    result = await db.execute(select(AzureAccount).where(AzureAccount.user_id == user.id))
    accounts = result.scalars().all()
    return [
        AccountResponse(
            id=a.id,
            name=a.name,
            tenant_id=a.tenant_id,
            client_id=a.client_id,
            subscription_id=a.subscription_id,
            remark=a.remark,
            created_at=a.created_at,
        )
        for a in accounts
    ]


@router.post("/add", response_model=AccountResponse)
async def add_account(
    payload: AccountCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AccountResponse:
    client = AzureClient(
        AzureCredentials(
            tenant_id=payload.tenant_id,
            client_id=payload.client_id,
            client_secret=payload.client_secret,
            subscription_id=payload.subscription_id,
        )
    )
    try:
        await client._get_token()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=400, detail=f"Azure 凭据验证失败: {exc.response.text}") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=400, detail=f"无法连接 Azure: {exc}") from exc

    account = AzureAccount(
        user_id=user.id,
        name=payload.name,
        tenant_id=payload.tenant_id,
        client_id=payload.client_id,
        client_secret_encrypted=encrypt_secret(payload.client_secret),
        subscription_id=payload.subscription_id,
        remark=payload.remark,
    )
    db.add(account)
    await db.commit()
    await db.refresh(account)
    return AccountResponse(
        id=account.id,
        name=account.name,
        tenant_id=account.tenant_id,
        client_id=account.client_id,
        subscription_id=account.subscription_id,
        remark=account.remark,
        created_at=account.created_at,
    )


@router.delete("/delete")
async def delete_account(
    account_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    account = await get_user_account(db, user, account_id)
    await db.delete(account)
    await db.commit()
    return {"message": "已删除"}
