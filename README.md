# Azure Panel / Azure 虚拟机管理面板

<p align="center">
  <strong>Modern full-stack Azure VM management panel with auto-replenishment workflows</strong><br>
  <strong>现代全栈 Azure 虚拟机管理面板，内置自动开机补机工作流</strong>
</p>

<p align="center">
  <a href="#中文文档">中文</a> ·
  <a href="#english">English</a> ·
  <a href="deploy/aapanel/INSTALL.md">aaPanel 部署详解</a>
</p>

---

## 中文文档

### 简介

Azure Panel 是一个基于 **SvelteKit 2 + TypeScript** 的全栈 Web 应用，用于管理 Azure 虚拟机：支持多账号、VM 开关机、自动开机与自动补机（数量不足时创建新 VM），并提供工作流日志。

> 旧版 Python 实现（`backend/`）已弃用，请使用当前 TypeScript 全栈版本。

### 功能特性

- 用户注册 / 登录（JWT）
- 多 Azure 账号管理（Service Principal）
- VM 列表、开机、关机（deallocate）、重启
- **自动补机策略**：停止的 VM 自动开机；运行数量不足时自动创建 VM
- 工作流执行日志与手动触发检查
- 支持 **SQLite**（本地开发）与 **MySQL 8.0**（aaPanel 生产）

### 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | Svelte 5、Tailwind CSS、SvelteKit |
| 后端 | SvelteKit Server Routes（同仓全栈） |
| 数据库 | SQLite / MySQL 8.0 + Drizzle ORM |
| 云 API | @azure/identity、@azure/arm-compute、@azure/arm-network |
| 认证 | JWT (jose) + bcryptjs |
| 工作流 | Node.js Worker（开发内嵌 / 生产 Supervisor 独立进程） |

### 本地开发

**环境要求：** Node.js 20/22 LTS、npm

```powershell
git clone https://github.com/kexue-aihao/Azure-Panel.git
cd Azure-Panel
npm install
copy .env.example .env   # Linux/macOS: cp .env.example .env
# 编辑 .env，设置 SECRET_KEY 和 ENCRYPTION_KEY
npm run dev
```

访问：**http://localhost:8080**

本地默认使用 SQLite（`data/azure-panel.db` 自动创建），补机 Worker 内嵌在 Web 进程（`ENABLE_EMBEDDED_WORKER=true`）。

Windows 下若 `better-sqlite3` 编译失败，请安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) 并勾选「使用 C++ 的桌面开发」。

### 生产构建

```bash
npm run build:all      # 构建 Web (build/index.js) + Worker (build/worker.js)
npm run start          # 启动 Web，默认 127.0.0.1:3000
npm run start:worker   # 独立启动补机 Worker
```

### aaPanel 部署流程

适用于已安装 **Nginx + MySQL 8.0 + Supervisor** 的 aaPanel（宝塔）服务器。

#### 架构

```
浏览器 → Nginx(:80/443) → Node Web(:3000) → MySQL 8.0
                              ↓
                    Supervisor Worker → Azure API
```

#### 步骤 1：安装 Node.js

aaPanel → 软件商店 → 安装 **Node.js 版本管理器** → 选择 **Node 20 LTS**

```bash
node -v && npm -v && which node
```

#### 步骤 2：克隆项目

```bash
cd /www/wwwroot
git clone -b master https://github.com/kexue-aihao/Azure-Panel.git azure-panel
cd azure-panel
```

#### 步骤 3：创建数据库

1. aaPanel → 数据库 → 添加数据库（库名/用户：`azure_panel`）
2. phpMyAdmin → 导入 `deploy/aapanel/schema.mysql.sql`

#### 步骤 4：配置环境变量

```bash
cp .env.example .env
nano .env
```

生产环境关键配置：

```env
DB_DRIVER=mysql
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=azure_panel
MYSQL_PASSWORD=你的密码
MYSQL_DATABASE=azure_panel

SECRET_KEY=随机长字符串
ENCRYPTION_KEY=32位随机密钥
HOST=127.0.0.1
PORT=3000
ENABLE_EMBEDDED_WORKER=false
```

#### 步骤 5：构建

```bash
npm install
npm run build:all
```

#### 步骤 6：Supervisor 守护进程

在 aaPanel Supervisor 中添加两个进程：

| 名称 | 启动命令 | 运行目录 |
|------|----------|----------|
| `azure-panel-web` | `/usr/bin/node /www/wwwroot/azure-panel/build/index.js` | `/www/wwwroot/azure-panel` |
| `azure-panel-worker` | `/usr/bin/node /www/wwwroot/azure-panel/build/worker.js` | `/www/wwwroot/azure-panel` |

参考配置：`deploy/aapanel/supervisor-web.conf`、`supervisor-worker.conf`

#### 步骤 7：Nginx 反向代理

aaPanel → 网站 → 添加站点 → 在配置中加入：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

完整示例见 `deploy/aapanel/nginx.conf`，详细图文步骤见 [deploy/aapanel/INSTALL.md](deploy/aapanel/INSTALL.md)。

#### 步骤 8：验证

```bash
curl http://127.0.0.1:3000/api/health
```

浏览器访问域名，注册账号后即可使用。

### 源站一键升级

服务器已部署后，后续更新执行：

```bash
cd /www/wwwroot/azure-panel
chmod +x update.sh
./update.sh
```

脚本自动完成：`git pull` → `npm install` → `npm run build:all` → 重启 Supervisor → 健康检查。

可选环境变量：`APP_DIR`、`GIT_BRANCH`、`SKIP_SUPERVISOR=1`

### Azure 权限要求

Service Principal 需具备订阅级权限：

- `Microsoft.Compute/virtualMachines/read`
- `Microsoft.Compute/virtualMachines/start/action`
- `Microsoft.Compute/virtualMachines/deallocate/action`
- `Microsoft.Compute/virtualMachines/restart/action`
- 自动补机创建 VM 还需 Network 与 Compute 写入权限

### 目录结构

```
src/
  lib/server/       # Azure SDK、数据库、Worker
  routes/api/       # REST API
  routes/(app)/     # 面板页面
  worker-entry.ts   # 独立 Worker 入口
deploy/aapanel/     # aaPanel 部署配置与 SQL
update.sh           # 源站一键升级脚本
```

---

## English

### Introduction

Azure Panel is a **SvelteKit 2 + TypeScript** full-stack web application for managing Azure virtual machines. It supports multiple accounts, VM power operations, auto-start, and auto-replenishment (create new VMs when running count is below threshold), with workflow logging.

> The legacy Python implementation (`backend/`) is deprecated. Use the TypeScript full-stack version.

### Features

- User registration / login (JWT)
- Multiple Azure accounts (Service Principal)
- VM list, start, stop (deallocate), restart
- **Auto-replenishment policies**: auto-start stopped VMs; auto-create VMs when below minimum count
- Workflow execution logs and manual trigger
- **SQLite** (local dev) and **MySQL 8.0** (aaPanel production)

### Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Svelte 5, Tailwind CSS, SvelteKit |
| Backend | SvelteKit Server Routes (monorepo full-stack) |
| Database | SQLite / MySQL 8.0 + Drizzle ORM |
| Cloud API | @azure/identity, @azure/arm-compute, @azure/arm-network |
| Auth | JWT (jose) + bcryptjs |
| Workflow | Node.js Worker (embedded in dev / standalone via Supervisor in prod) |

### Local Development

**Requirements:** Node.js 20/22 LTS, npm

```bash
git clone https://github.com/kexue-aihao/Azure-Panel.git
cd Azure-Panel
npm install
cp .env.example .env
# Edit .env: set SECRET_KEY and ENCRYPTION_KEY
npm run dev
```

Open **http://localhost:8080**

Local dev uses SQLite (`data/azure-panel.db` auto-created). The replenishment worker runs embedded in the web process (`ENABLE_EMBEDDED_WORKER=true`).

On Windows, if `better-sqlite3` fails to compile, install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the C++ desktop development workload.

### Production Build

```bash
npm run build:all      # Build Web (build/index.js) + Worker (build/worker.js)
npm run start          # Start web server, default 127.0.0.1:3000
npm run start:worker   # Start standalone replenishment worker
```

### aaPanel Deployment

For servers with **Nginx + MySQL 8.0 + Supervisor** (aaPanel / BT Panel).

#### Architecture

```
Browser → Nginx(:80/443) → Node Web(:3000) → MySQL 8.0
                               ↓
                     Supervisor Worker → Azure API
```

#### Step 1: Install Node.js

aaPanel → App Store → **Node.js Version Manager** → select **Node 20 LTS**

```bash
node -v && npm -v && which node
```

#### Step 2: Clone Repository

```bash
cd /www/wwwroot
git clone -b master https://github.com/kexue-aihao/Azure-Panel.git azure-panel
cd azure-panel
```

#### Step 3: Create Database

1. aaPanel → Database → Add database (name/user: `azure_panel`)
2. phpMyAdmin → Import `deploy/aapanel/schema.mysql.sql`

#### Step 4: Configure Environment

```bash
cp .env.example .env
nano .env
```

Production essentials:

```env
DB_DRIVER=mysql
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=azure_panel
MYSQL_PASSWORD=your-password
MYSQL_DATABASE=azure_panel

SECRET_KEY=long-random-string
ENCRYPTION_KEY=32-char-random-key!!
HOST=127.0.0.1
PORT=3000
ENABLE_EMBEDDED_WORKER=false
```

#### Step 5: Build

```bash
npm install
npm run build:all
```

#### Step 6: Supervisor Processes

Add two programs in aaPanel Supervisor:

| Name | Command | Directory |
|------|---------|-----------|
| `azure-panel-web` | `/usr/bin/node /www/wwwroot/azure-panel/build/index.js` | `/www/wwwroot/azure-panel` |
| `azure-panel-worker` | `/usr/bin/node /www/wwwroot/azure-panel/build/worker.js` | `/www/wwwroot/azure-panel` |

See `deploy/aapanel/supervisor-web.conf` and `supervisor-worker.conf`.

#### Step 7: Nginx Reverse Proxy

aaPanel → Website → Add site → add to config:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Full example: `deploy/aapanel/nginx.conf`. Detailed guide: [deploy/aapanel/INSTALL.md](deploy/aapanel/INSTALL.md).

#### Step 8: Verify

```bash
curl http://127.0.0.1:3000/api/health
```

Visit your domain in a browser and register an account.

### One-Click Update (Production)

After initial deployment:

```bash
cd /www/wwwroot/azure-panel
chmod +x update.sh
./update.sh
```

The script runs: `git pull` → `npm install` → `npm run build:all` → restart Supervisor → health check.

Optional env vars: `APP_DIR`, `GIT_BRANCH`, `SKIP_SUPERVISOR=1`

### Azure Permissions

Service Principal requires subscription-level permissions:

- `Microsoft.Compute/virtualMachines/read`
- `Microsoft.Compute/virtualMachines/start/action`
- `Microsoft.Compute/virtualMachines/deallocate/action`
- `Microsoft.Compute/virtualMachines/restart/action`
- Auto-create VMs also require Network and Compute write permissions

### Project Structure

```
src/
  lib/server/       # Azure SDK, database, worker
  routes/api/       # REST API
  routes/(app)/     # Dashboard pages
  worker-entry.ts   # Standalone worker entry
deploy/aapanel/     # aaPanel configs and SQL schema
update.sh           # Production update script
```

---

## License

MIT — use at your own risk. Ensure Azure credentials and encryption keys are stored securely.
