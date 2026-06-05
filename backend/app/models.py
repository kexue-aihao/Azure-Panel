from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    accounts: Mapped[list["AzureAccount"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    workflows: Mapped[list["WorkflowPolicy"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class AzureAccount(Base):
    __tablename__ = "azure_accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    tenant_id: Mapped[str] = mapped_column(String(64))
    client_id: Mapped[str] = mapped_column(String(64))
    client_secret_encrypted: Mapped[str] = mapped_column(Text)
    subscription_id: Mapped[str] = mapped_column(String(64))
    remark: Mapped[str] = mapped_column(String(255), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user: Mapped["User"] = relationship(back_populates="accounts")
    workflows: Mapped[list["WorkflowPolicy"]] = relationship(back_populates="account", cascade="all, delete-orphan")


class WorkflowPolicy(Base):
    __tablename__ = "workflow_policies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("azure_accounts.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    resource_group: Mapped[str] = mapped_column(String(90))
    location: Mapped[str] = mapped_column(String(64), default="eastus")
    vm_names: Mapped[str] = mapped_column(Text, default="[]")
    min_running_count: Mapped[int] = mapped_column(Integer, default=1)
    auto_start: Mapped[bool] = mapped_column(Boolean, default=True)
    auto_create: Mapped[bool] = mapped_column(Boolean, default=False)
    vm_size: Mapped[str] = mapped_column(String(64), default="Standard_B1s")
    image_reference: Mapped[str] = mapped_column(
        String(255), default="Canonical:ubuntu-24_04-lts:server:latest"
    )
    name_prefix: Mapped[str] = mapped_column(String(32), default="auto-vm")
    admin_username: Mapped[str] = mapped_column(String(32), default="azureuser")
    admin_password_encrypted: Mapped[str] = mapped_column(Text, default="")
    check_interval_seconds: Mapped[int] = mapped_column(Integer, default=120)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user: Mapped["User"] = relationship(back_populates="workflows")
    account: Mapped["AzureAccount"] = relationship(back_populates="workflows")
    logs: Mapped[list["WorkflowLog"]] = relationship(back_populates="policy", cascade="all, delete-orphan")


class WorkflowLog(Base):
    __tablename__ = "workflow_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    policy_id: Mapped[int] = mapped_column(ForeignKey("workflow_policies.id", ondelete="CASCADE"), index=True)
    action: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(32))
    message: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    policy: Mapped["WorkflowPolicy"] = relationship(back_populates="logs")
