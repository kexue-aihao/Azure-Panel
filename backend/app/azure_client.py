from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import httpx

from app.config import get_settings

settings = get_settings()
RUNNING_STATES = {"PowerState/running", "PowerState/starting"}


@dataclass
class AzureCredentials:
    tenant_id: str
    client_id: str
    client_secret: str
    subscription_id: str


class AzureClient:
    def __init__(self, creds: AzureCredentials) -> None:
        self.creds = creds
        self._token: str | None = None

    async def _get_token(self) -> str:
        if self._token:
            return self._token
        url = f"https://login.microsoftonline.com/{self.creds.tenant_id}/oauth2/v2.0/token"
        data = {
            "client_id": self.creds.client_id,
            "client_secret": self.creds.client_secret,
            "scope": "https://management.azure.com/.default",
            "grant_type": "client_credentials",
        }
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(url, data=data)
            resp.raise_for_status()
            self._token = resp.json()["access_token"]
            return self._token

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        token = await self._get_token()
        headers = kwargs.pop("headers", {})
        headers["Authorization"] = f"Bearer {token}"
        url = f"https://management.azure.com{path}"
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.request(method, url, headers=headers, **kwargs)
            return resp

    async def list_vms(self, resource_group: str | None = None) -> list[dict[str, Any]]:
        if resource_group:
            path = (
                f"/subscriptions/{self.creds.subscription_id}/resourceGroups/{resource_group}"
                f"/providers/Microsoft.Compute/virtualMachines?api-version={settings.azure_api_version}"
            )
        else:
            path = (
                f"/subscriptions/{self.creds.subscription_id}/providers/Microsoft.Compute/virtualMachines"
                f"?api-version={settings.azure_api_version}"
            )
        items: list[dict[str, Any]] = []
        async with httpx.AsyncClient(timeout=60) as client:
            token = await self._get_token()
            url = f"https://management.azure.com{path}"
            while url:
                resp = await client.get(url, headers={"Authorization": f"Bearer {token}"})
                resp.raise_for_status()
                data = resp.json()
                items.extend(data.get("value", []))
                url = data.get("nextLink")
        return items

    async def get_vm_instance_view(self, resource_group: str, vm_name: str) -> dict[str, Any]:
        path = (
            f"/subscriptions/{self.creds.subscription_id}/resourceGroups/{resource_group}"
            f"/providers/Microsoft.Compute/virtualMachines/{vm_name}/instanceView"
            f"?api-version={settings.azure_api_version}"
        )
        resp = await self._request("GET", path)
        resp.raise_for_status()
        return resp.json()

    async def get_power_state(self, resource_group: str, vm_name: str) -> str:
        view = await self.get_vm_instance_view(resource_group, vm_name)
        for status in view.get("statuses", []):
            code = status.get("code", "")
            if code.startswith("PowerState/"):
                return code
        return "PowerState/unknown"

    async def start_vm(self, resource_group: str, vm_name: str) -> None:
        path = (
            f"/subscriptions/{self.creds.subscription_id}/resourceGroups/{resource_group}"
            f"/providers/Microsoft.Compute/virtualMachines/{vm_name}/start"
            f"?api-version={settings.azure_api_version}"
        )
        resp = await self._request("POST", path)
        if resp.status_code not in (200, 202):
            resp.raise_for_status()

    async def deallocate_vm(self, resource_group: str, vm_name: str) -> None:
        path = (
            f"/subscriptions/{self.creds.subscription_id}/resourceGroups/{resource_group}"
            f"/providers/Microsoft.Compute/virtualMachines/{vm_name}/deallocate"
            f"?api-version={settings.azure_api_version}"
        )
        resp = await self._request("POST", path)
        if resp.status_code not in (200, 202):
            resp.raise_for_status()

    async def restart_vm(self, resource_group: str, vm_name: str) -> None:
        path = (
            f"/subscriptions/{self.creds.subscription_id}/resourceGroups/{resource_group}"
            f"/providers/Microsoft.Compute/virtualMachines/{vm_name}/restart"
            f"?api-version={settings.azure_api_version}"
        )
        resp = await self._request("POST", path)
        if resp.status_code not in (200, 202):
            resp.raise_for_status()

    async def wait_for_power_state(
        self,
        resource_group: str,
        vm_name: str,
        target_states: set[str],
        timeout_seconds: int = 600,
        poll_seconds: int = 10,
    ) -> str:
        elapsed = 0
        while elapsed < timeout_seconds:
            state = await self.get_power_state(resource_group, vm_name)
            if state in target_states:
                return state
            await asyncio.sleep(poll_seconds)
            elapsed += poll_seconds
        return await self.get_power_state(resource_group, vm_name)

    async def create_vm_simple(
        self,
        resource_group: str,
        location: str,
        vm_name: str,
        vm_size: str,
        image_reference: str,
        admin_username: str,
        admin_password: str,
    ) -> None:
        publisher, offer, sku, version = image_reference.split(":", 3)
        vnet_name = f"{vm_name}-vnet"
        subnet_name = "default"
        nic_name = f"{vm_name}-nic"
        pip_name = f"{vm_name}-pip"

        await self._ensure_resource_group(resource_group, location)
        await self._ensure_vnet(resource_group, location, vnet_name, subnet_name)
        await self._ensure_public_ip(resource_group, location, pip_name)
        await self._ensure_nic(resource_group, location, nic_name, vnet_name, subnet_name, pip_name)

        body = {
            "location": location,
            "properties": {
                "hardwareProfile": {"vmSize": vm_size},
                "storageProfile": {
                    "imageReference": {
                        "publisher": publisher,
                        "offer": offer,
                        "sku": sku,
                        "version": version,
                    }
                },
                "osProfile": {
                    "computerName": vm_name,
                    "adminUsername": admin_username,
                    "adminPassword": admin_password,
                },
                "networkProfile": {
                    "networkInterfaces": [
                        {
                            "id": (
                                f"/subscriptions/{self.creds.subscription_id}/resourceGroups/{resource_group}"
                                f"/providers/Microsoft.Network/networkInterfaces/{nic_name}"
                            ),
                            "properties": {"primary": True},
                        }
                    ]
                },
            },
        }
        path = (
            f"/subscriptions/{self.creds.subscription_id}/resourceGroups/{resource_group}"
            f"/providers/Microsoft.Compute/virtualMachines/{vm_name}"
            f"?api-version={settings.azure_api_version}"
        )
        resp = await self._request("PUT", path, json=body)
        if resp.status_code not in (200, 201):
            resp.raise_for_status()

    async def _ensure_resource_group(self, name: str, location: str) -> None:
        path = f"/subscriptions/{self.creds.subscription_id}/resourcegroups/{name}?api-version=2021-04-01"
        resp = await self._request("PUT", path, json={"location": location})
        if resp.status_code not in (200, 201):
            resp.raise_for_status()

    async def _ensure_vnet(self, rg: str, location: str, vnet_name: str, subnet_name: str) -> None:
        path = (
            f"/subscriptions/{self.creds.subscription_id}/resourceGroups/{rg}"
            f"/providers/Microsoft.Network/virtualNetworks/{vnet_name}?api-version=2024-05-01"
        )
        body = {
            "location": location,
            "properties": {
                "addressSpace": {"addressPrefixes": ["10.0.0.0/16"]},
                "subnets": [{"name": subnet_name, "properties": {"addressPrefix": "10.0.0.0/24"}}],
            },
        }
        resp = await self._request("PUT", path, json=body)
        if resp.status_code not in (200, 201):
            resp.raise_for_status()

    async def _ensure_public_ip(self, rg: str, location: str, name: str) -> None:
        path = (
            f"/subscriptions/{self.creds.subscription_id}/resourceGroups/{rg}"
            f"/providers/Microsoft.Network/publicIPAddresses/{name}?api-version=2024-05-01"
        )
        body = {
            "location": location,
            "sku": {"name": "Basic"},
            "properties": {"publicIPAllocationMethod": "Dynamic"},
        }
        resp = await self._request("PUT", path, json=body)
        if resp.status_code not in (200, 201):
            resp.raise_for_status()

    async def _ensure_nic(
        self, rg: str, location: str, nic_name: str, vnet_name: str, subnet_name: str, pip_name: str
    ) -> None:
        path = (
            f"/subscriptions/{self.creds.subscription_id}/resourceGroups/{rg}"
            f"/providers/Microsoft.Network/networkInterfaces/{nic_name}?api-version=2024-05-01"
        )
        subnet_id = (
            f"/subscriptions/{self.creds.subscription_id}/resourceGroups/{rg}"
            f"/providers/Microsoft.Network/virtualNetworks/{vnet_name}/subnets/{subnet_name}"
        )
        pip_id = (
            f"/subscriptions/{self.creds.subscription_id}/resourceGroups/{rg}"
            f"/providers/Microsoft.Network/publicIPAddresses/{pip_name}"
        )
        body = {
            "location": location,
            "properties": {
                "ipConfigurations": [
                    {
                        "name": "ipconfig1",
                        "properties": {
                            "subnet": {"id": subnet_id},
                            "privateIPAllocationMethod": "Dynamic",
                            "publicIPAddress": {"id": pip_id},
                        },
                    }
                ],
            },
        }
        resp = await self._request("PUT", path, json=body)
        if resp.status_code not in (200, 201):
            resp.raise_for_status()


def parse_vm(vm: dict[str, Any], power_state: str = "PowerState/unknown") -> dict[str, Any]:
    resource_id = vm.get("id", "")
    resource_group = resource_id.split("/resourceGroups/")[1].split("/")[0] if "/resourceGroups/" in resource_id else ""
    props = vm.get("properties", {})
    return {
        "name": vm.get("name", ""),
        "resource_group": resource_group,
        "location": vm.get("location", ""),
        "vm_size": props.get("hardwareProfile", {}).get("vmSize", ""),
        "power_state": power_state.replace("PowerState/", ""),
        "provisioning_state": props.get("provisioningState", ""),
    }
