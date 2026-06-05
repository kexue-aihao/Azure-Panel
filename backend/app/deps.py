from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.azure_client import AzureClient, AzureCredentials
from app.models import AzureAccount, User
from app.security import decrypt_secret


async def get_user_account(db: AsyncSession, user: User, account_id: int) -> AzureAccount:
    result = await db.execute(
        select(AzureAccount).where(AzureAccount.id == account_id, AzureAccount.user_id == user.id)
    )
    account = result.scalar_one_or_none()
    if account is None:
        raise HTTPException(status_code=404, detail="Azure 账号不存在")
    return account


def build_azure_client(account: AzureAccount) -> AzureClient:
    return AzureClient(
        AzureCredentials(
            tenant_id=account.tenant_id,
            client_id=account.client_id,
            client_secret=decrypt_secret(account.client_secret_encrypted),
            subscription_id=account.subscription_id,
        )
    )
