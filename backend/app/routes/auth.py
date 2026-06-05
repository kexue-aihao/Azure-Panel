from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import User
from app.schemas import LoginRequest, RegisterRequest, TokenResponse
from app.security import create_access_token, hash_password, verify_password

router = APIRouter(prefix="/api/guest", tags=["auth"])


@router.post("/register", response_model=TokenResponse)
async def register(payload: RegisterRequest, db: AsyncSession = Depends(get_db)) -> TokenResponse:
    exists = await db.execute(select(User).where(User.email == payload.email))
    if exists.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="邮箱已注册")

    user = User(email=payload.email, password_hash=hash_password(payload.password))
    db.add(user)
    await db.commit()
    await db.refresh(user)
    token = create_access_token(user.id, user.email)
    return TokenResponse(token=token, email=user.email)


@router.post("/login", response_model=TokenResponse)
async def login(payload: LoginRequest, db: AsyncSession = Depends(get_db)) -> TokenResponse:
    result = await db.execute(select(User).where(User.email == payload.email))
    user = result.scalar_one_or_none()
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="邮箱或密码错误")

    token = create_access_token(user.id, user.email)
    return TokenResponse(token=token, email=user.email)
