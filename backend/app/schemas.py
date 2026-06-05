from datetime import datetime

from pydantic import BaseModel, EmailStr, Field


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=6, max_length=128)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    token: str
    email: str


class AccountCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    tenant_id: str
    client_id: str
    client_secret: str
    subscription_id: str
    remark: str = ""


class AccountResponse(BaseModel):
    id: int
    name: str
    tenant_id: str
    client_id: str
    subscription_id: str
    remark: str
    created_at: datetime


class VmPowerRequest(BaseModel):
    account_id: int
    resource_group: str
    vm_name: str


class VmInfo(BaseModel):
    name: str
    resource_group: str
    location: str
    vm_size: str
    power_state: str
    provisioning_state: str


class WorkflowCreate(BaseModel):
    account_id: int
    name: str = Field(min_length=1, max_length=120)
    resource_group: str
    location: str = "eastus"
    vm_names: list[str] = Field(default_factory=list)
    min_running_count: int = Field(default=1, ge=0, le=100)
    auto_start: bool = True
    auto_create: bool = False
    vm_size: str = "Standard_B1s"
    image_reference: str = "Canonical:ubuntu-24_04-lts:server:latest"
    name_prefix: str = "auto-vm"
    admin_username: str = "azureuser"
    admin_password: str = ""
    check_interval_seconds: int = Field(default=120, ge=30, le=3600)
    enabled: bool = True


class WorkflowUpdate(BaseModel):
    name: str | None = None
    resource_group: str | None = None
    location: str | None = None
    vm_names: list[str] | None = None
    min_running_count: int | None = Field(default=None, ge=0, le=100)
    auto_start: bool | None = None
    auto_create: bool | None = None
    vm_size: str | None = None
    image_reference: str | None = None
    name_prefix: str | None = None
    admin_username: str | None = None
    admin_password: str | None = None
    check_interval_seconds: int | None = Field(default=None, ge=30, le=3600)
    enabled: bool | None = None


class WorkflowResponse(BaseModel):
    id: int
    account_id: int
    name: str
    enabled: bool
    resource_group: str
    location: str
    vm_names: list[str]
    min_running_count: int
    auto_start: bool
    auto_create: bool
    vm_size: str
    image_reference: str
    name_prefix: str
    admin_username: str
    check_interval_seconds: int
    last_run_at: datetime | None
    created_at: datetime


class WorkflowLogResponse(BaseModel):
    id: int
    policy_id: int
    action: str
    status: str
    message: str
    created_at: datetime
