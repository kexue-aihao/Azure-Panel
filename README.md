# Azure Panel

基于 **SvelteKit 2 + TypeScript + Drizzle ORM + Azure SDK** 的现代全栈 Azure 虚拟机管理面板，内置自动开机补机工作流。

> 旧版 Python 实现已弃用，请使用本 TypeScript 全栈版本。

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | Svelte 5、Tailwind CSS、SvelteKit 路由 |
| 后端 | SvelteKit Server Routes（同仓全栈） |
| 数据库 | SQLite（开发）/ MySQL 8.0（aaPanel 生产） |
| 云 API | @azure/identity、@azure/arm-compute、@azure/arm-network |
| 认证 | JWT (jose) + bcryptjs |
| 工作流 | Node.js Worker（开发内嵌 / 生产 Supervisor 独立进程） |

## aaPanel 部署（推荐生产环境）

你的服务器已具备 **Nginx + MySQL 8.0 + Supervisor**，可直接部署：

📄 **完整步骤见：[deploy/aapanel/INSTALL.md](deploy/aapanel/INSTALL.md)**

快速概览：

```
1. 安装 Node.js 20 LTS（aaPanel 软件商店）
2. 上传项目到 /www/wwwroot/azure-panel
3. phpMyAdmin 导入 deploy/aapanel/schema.mysql.sql
4. 配置 .env（DB_DRIVER=mysql, ENABLE_EMBEDDED_WORKER=false）
5. npm install && npm run build:all
6. Supervisor 守护 build/index.js（Web）和 build/worker.js（补机）
7. Nginx 反代到 127.0.0.1:3000（参考 deploy/aapanel/nginx.conf）
```

部署资源目录：

```
deploy/aapanel/
  INSTALL.md              # 中文部署文档
  schema.mysql.sql        # MySQL 建表脚本
  nginx.conf              # Nginx 反代示例
  supervisor-web.conf     # Web 进程
  supervisor-worker.conf  # 补机 Worker 进程
```

## 本地开发

### 依赖

- Node.js LTS（v20 或 v22，带 npm）
- Windows 下若 `better-sqlite3` 编译失败，需安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)

### 启动

```powershell
cd "E:\Azure-Panel"
npm install
copy .env.example .env
# 编辑 .env，设置 SECRET_KEY 和 ENCRYPTION_KEY
npm run dev
```

浏览器访问：**http://localhost:8080**

本地默认使用 SQLite，补机 Worker 内嵌在 Web 进程中（`ENABLE_EMBEDDED_WORKER=true`）。

## 生产构建

```bash
npm run build:all   # 同时构建 Web + Worker
npm run start       # 启动 Web（监听 PORT，默认 3000）
npm run start:worker  # 独立启动补机 Worker（aaPanel 由 Supervisor 管理）
```

## 功能

- 用户注册 / 登录
- 多 Azure 账号（Service Principal）
- VM 列表、开机、关机（deallocate）、重启
- **自动补机策略**：
  - 自动开机已停止 VM
  - 运行数量不足时自动创建新 VM
- 工作流执行日志

## Azure 权限

Service Principal 需要订阅级权限：

- `Microsoft.Compute/virtualMachines/read`
- `Microsoft.Compute/virtualMachines/start/action`
- `Microsoft.Compute/virtualMachines/deallocate/action`
- `Microsoft.Compute/virtualMachines/restart/action`
- 自动补机创建 VM 还需 Network 与 Compute 写入权限

## 目录结构

```
src/
  lib/server/       # 服务端：Azure SDK、数据库、Worker
  routes/api/       # REST API
  routes/(app)/     # 面板页面
  worker-entry.ts   # aaPanel 独立 Worker 入口
deploy/aapanel/     # aaPanel 部署配置与文档
data/               # SQLite 数据库（本地开发自动创建）
```
