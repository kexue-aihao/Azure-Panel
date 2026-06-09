# Azure Panel

Azure Panel 是一个 **Go 高性能 Azure 资源管理面板**，生产入口由 Go 主进程接管，迁移期保留 SvelteKit/Node 本机兼容后端与独立 Worker，用于多 Azure 账号池管理、代理出站、VM 创建与运维、自动补机、DNS 同步、Telegram 通知和管理员后台统一管理。

> 当前生产架构已切换为 Go 主入口。Go 进程监听 `3000`，负责 Web 静态入口、健康检查、补机调度队列和 Go API；未完全迁移的旧 API 暂由仅绑定 `127.0.0.1:3001` 的 Node 兼容后端兜底。旧版 Python 后端不再作为推荐入口。

## 功能总览

### 账号与安全

- 用户注册、登录、JWT 会话认证。
- 第一个注册用户自动成为管理员，也可以通过环境变量指定管理员邮箱。
- 支持管理员后台创建用户、禁用/启用用户、升降级用户角色、单个/批量删除用户。
- 支持 TOTP 二步验证码，兼容 Google Authenticator 和 Microsoft Authenticator。
- 服务端加密存储 Azure Client Secret、代理密码、DNS 密钥、Telegram Token、TOTP Secret 等敏感信息。
- 管理员查看用户详情时仅返回脱敏信息，不返回密钥原文。

### 多语言

- 默认语言为中文。
- 内置语言入口，支持中文、英文、日文、俄文基础翻译。
- 当前导航、登录、管理员后台以及部分自动补机新增功能文案已接入多语言；其余页面会按后续功能迭代继续补齐。

### Azure 账号池

- 支持手动添加 Azure Service Principal。
- 支持快速识别导入常见账号资料格式。
- 支持账号状态检测，正常账号可标记成功，异常账号可标记失败。
- 支持账号池剩余数量检测和 Telegram 通知。
- 支持账号绑定代理，自动补机时优先使用账号绑定代理。
- 添加账号时会尝试检测 Provider 状态，缺失时后台自动注册常用 Provider。
- 支持区域、镜像、Provider 信息缓存，首次加载成功后后续优先使用缓存。

### 代理配置

- 支持 HTTP 代理、SOCKS5 代理。
- 支持 `host:port:user:pass` 格式自动识别。
- 支持代理 API 批量导入，例如代理服务商返回的批量代理接口。
- 支持单线程代理测活、删除无效代理。
- 支持使用当前访问网站的客户端 IP 作为出站代理配置。
- 支持 VLESS 等分享链接识别，并通过内置 sing-box / Xray 托管核心转换为本地代理端口。
- 自动补机时如果账号绑定代理不可用，会从 HTTP/SOCKS 代理池中切换可用代理。

### VM 创建与管理

- 使用 Azure 官方 API 查询账号可用区域、实例规格、镜像系统。
- 支持创建 Linux / Windows VM。
- 支持创建 IPv4 / IPv6 公网 IP。
- 支持创建时注入 UserData / cloud-init。
- 支持随机资源组、随机 VM 名称、随机管理员密码。
- 支持创建流程弹窗、动态进度条、步骤日志和刷到过的 IP 展示。
- 默认同步 NSG 防火墙策略，放行 `0-65535` 全部端口。
- 支持开机、关机、重启。
- 支持删除 VM 所在资源组，并显示删除进度。
- 支持一键删除检测到的相关资源组。
- 支持刷新网卡配置、重新读取 IPv4 / IPv6。
- 支持更换 IPv4，流程为先创建新 IPv4 Public IP，再解绑旧 IPv4，再绑定新 IPv4，最后删除旧 IP。
- 支持刷 IPv4 前缀，命中目标前缀后同步 DNS。
- 支持为 VM 单独开启 Azure DDoS 防护计划。
- 支持创建 VM 时启用 Azure 加速网络。
- 支持 VM 防火墙策略管理接口。

### 自动补机

- 独立 Worker 默认每 30 秒检测正在使用账号的订阅状态。
- Go 主面板提供补机调度入口，Node Worker 作为迁移期兼容执行层，后续 Azure 创建链路会继续下沉到 Go。
- 触发异常状态包括 `banned`、`warning`、`warned`、`disabled`。
- 检测到异常会发送 Telegram 通知，并立即进入补机流程。
- 上一轮补机流程完成前不会再次触发新一轮补机，避免重复创建资源。
- 补机账号从 Azure 号池中选择，默认按加入号池时间顺序使用。
- 支持补机账号顺序策略：按加入号池时间、按订阅启用时间、按 Azure 账号注册时间。
- 补机使用原策略中的区域、规格、镜像、UserData、IPv6、刷 IP 前缀、DNS 绑定等配置。
- 自动补机策略支持启用 IPv6、Azure 加速网络、Azure DDoS 防护计划。
- 自动补机默认刷 IPv4 前缀 `85.211`，默认最多尝试 30 次。
- 补机成功后发送通知、同步指定 DNS 解析、删除异常账号，并将监控账号切换到新补机账号。
- 补机失败会尝试删除本轮创建的临时资源组，降低下次重试资源组占用风险。
- 支持编辑已有补机策略，不需要删除后重新创建。

### DNS 管理

- 支持对接已部署的彩虹 DNS 管理系统。
- 支持配置 DNS 面板地址、账号密码、UID/API 信息。
- 支持查询域名、记录列表、保存记录、删除记录、启用/停用记录、备注管理。
- 支持创建 DNS 绑定，用于 VM 创建、自动补机、换 IPv4、刷 IPv4 段后的自动解析。
- 自动补机策略要求选择 DNS 绑定，补机成功后会同步 IPv4 到指定域名。

### Telegram 通知

- 支持 Telegram Bot Token。
- 支持个人 UID / Chat ID。
- 支持群组或频道 Chat ID，机器人所在群也可以接收通知。
- 支持账号池补充通知、账号池剩余数量通知、订阅状态检测通知、异常通知、补机成功通知、DNS 同步通知、代理检测通知。
- 订阅检测可每分钟执行，但同一账号状态通知默认 1 小时节流一次，避免 Telegram 限流。
- 首次检测、状态变化、查询失败变化会即时通知。

### 执行日志

- 记录 VM 创建、补机、换 IP、刷 IP、DNS 同步、防火墙、资源组删除、账号检测、代理检测等流程。
- 日志时间按中国北京时间 UTC+8 展示。
- 支持一键导出日志，方便排查问题。

### 管理员后台

- 查看所有注册用户。
- 查看用户资源统计，包括 Azure 账号、代理、DNS 配置、DNS 绑定、补机策略、日志数量。
- 后台创建普通用户或管理员用户。
- 禁用/启用用户。
- 用户和管理员角色升降级。
- 单个删除用户。
- 批量删除用户。
- 查看非管理员用户的脱敏完整资源信息。
- 删除用户时会同步清理该用户的账号、代理、DNS、通知、补机策略和日志记录。

## 技术栈

| 模块 | 技术 |
| --- | --- |
| 前端 | Svelte 5、SvelteKit、Tailwind CSS |
| 后端 | Go 主面板、Go API 调度层、迁移期本机 Node 兼容后端 |
| 数据库 | MySQL 8.0、SQLite、Drizzle ORM |
| Azure SDK | `@azure/identity`、`@azure/arm-compute`、`@azure/arm-network`、`@azure/arm-resources` |
| 安全 | JWT、bcryptjs、TOTP、服务端加密存储 |
| 代理 | HTTP/SOCKS Agent、sing-box、Xray |
| 部署 | Go 二进制、Supervisor、aaPanel / 宝塔兼容项目、Nginx 反向代理 |

## 目录结构

```text
src/
  lib/server/          服务端核心逻辑：Azure、数据库、代理、DNS、Telegram、Worker
  routes/api/          后端 API 路由
  routes/(app)/        登录后的面板页面
  worker-entry.ts      独立 Worker 入口

deploy/aapanel/        aaPanel 部署脚本、SQL 表结构、辅助脚本
install.sh             首次部署脚本
update.sh              后续升级脚本
.env.example           环境变量示例
```

## 环境要求

### 本地开发

- Node.js 20 LTS 或 22 LTS
- npm
- SQLite 或 MySQL

### 生产部署

- Linux 服务器
- aaPanel / 宝塔面板，推荐但非强制
- Nginx
- MySQL 8.0
- Node.js 20 LTS
- Go 1.22 或更高版本，脚本可在 Linux 上自动下载安装到项目 `bin/go-toolchain`
- Git
- curl、unzip、tar
- 可选：Supervisor 或 aaPanel 兼容项目守护进程

## 快速开始：本地开发

```bash
git clone https://github.com/kexue-aihao/Azure-Panel.git
cd Azure-Panel
npm install
cp .env.example .env
npm run dev
```

Windows PowerShell:

```powershell
git clone https://github.com/kexue-aihao/Azure-Panel.git
cd Azure-Panel
npm install
copy .env.example .env
npm.cmd run dev
```

本地开发可使用 SQLite：

```env
SECRET_KEY=replace-with-long-random-string
ENCRYPTION_KEY=replace-with-32-char-secret-key-here!!

DB_DRIVER=sqlite
SQLITE_PATH=./data/azure-panel.db

HOST=127.0.0.1
PORT=3000
ENABLE_EMBEDDED_WORKER=true
WORKER_INTERVAL_SECONDS=30
```

访问开发服务后注册第一个用户，第一个用户会自动成为管理员。

## 生产部署：aaPanel 一键安装

适合全新服务器或 aaPanel 站点目录部署。

```bash
mkdir -p /www/wwwroot/Azure-Panel
cd /www/wwwroot/Azure-Panel
curl -fsSL https://raw.githubusercontent.com/kexue-aihao/Azure-Panel/master/install.sh -o install.sh
chmod +x install.sh
sudo ./install.sh
```

脚本会自动完成：

- 拉取或同步 `origin/master` 代码。
- 检测 Node.js、npm 和 Go 工具链。
- 创建 MySQL 数据库和数据库用户。
- 导入 MySQL 表结构。
- 同步 aaPanel 数据库列表记录，方便 aaPanel 后台识别和备份数据库。
- 生成 `.env`、`SECRET_KEY`、`ENCRYPTION_KEY`。
- 安装 npm 依赖。
- 下载或检测 sing-box / Xray 托管代理核心。
- 构建 Web 和 Worker。
- 构建并启动 `bin/azure-panel-go` 主进程。
- 创建或重启 aaPanel 兼容项目 / Supervisor 进程。
- 执行健康检查。

安装后数据库凭据会保存到：

```bash
/www/wwwroot/Azure-Panel/deploy/aapanel/generated/db-credentials.txt
```

请妥善保存该文件，不要公开。

### 已有代码目录重新安装

如果已经拉取过仓库：

```bash
cd /www/wwwroot/Azure-Panel
chmod +x install.sh update.sh
sudo ./install.sh
```

### 非交互安装

```bash
cd /www/wwwroot/Azure-Panel
NON_INTERACTIVE=1 MYSQL_PASSWORD='your-strong-password' sudo ./install.sh
```

常用可选变量：

```bash
APP_DIR=/www/wwwroot/Azure-Panel
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=azure_panel
MYSQL_DATABASE=azure_panel
MYSQL_PASSWORD=your-strong-password
APP_PORT=3000
DOMAIN=your-domain.com
NODE_MAX_OLD_SPACE_SIZE=192
```

## 生产部署：手动安装

### 1. 克隆代码

```bash
cd /www/wwwroot
git clone -b master https://github.com/kexue-aihao/Azure-Panel.git Azure-Panel
cd Azure-Panel
npm install
```

### 2. 创建 MySQL 数据库

```sql
CREATE DATABASE azure_panel CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'azure_panel'@'127.0.0.1' IDENTIFIED BY 'your-password';
GRANT ALL PRIVILEGES ON azure_panel.* TO 'azure_panel'@'127.0.0.1';
FLUSH PRIVILEGES;
```

### 3. 导入表结构

```bash
mysql -h127.0.0.1 -P3306 -uazure_panel -p azure_panel < deploy/aapanel/schema.mysql.sql
```

### 4. 配置环境变量

```bash
cp .env.example .env
nano .env
```

生产环境推荐配置：

```env
SECRET_KEY=replace-with-long-random-string
ENCRYPTION_KEY=replace-with-32-char-secret-key-here!!

DB_DRIVER=mysql
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=azure_panel
MYSQL_PASSWORD=your-password
MYSQL_DATABASE=azure_panel

HOST=127.0.0.1
PORT=3000

ENABLE_EMBEDDED_WORKER=false
WORKER_INTERVAL_SECONDS=30
NODE_MAX_OLD_SPACE_SIZE=192

GO_PANEL_ENABLED=true
GO_PANEL_URL=http://127.0.0.1:3000
GO_PANEL_MODE=go
GO_PANEL_NODE_COMPAT_ENABLED=true
GO_PANEL_NODE_COMPAT_URL=http://127.0.0.1:3001
GO_PANEL_QUEUE_LIMIT=128
```

### 5. 构建

```bash
npm run build:all
go build -trimpath -ldflags "-s -w" -o bin/azure-panel-go ./services/panel/cmd/panel
```

### 6. 启动 Go 面板与兼容 Worker

```bash
bin/azure-panel-go
NODE_ENV=production HOST=127.0.0.1 PORT=3001 node build
NODE_ENV=production ENABLE_EMBEDDED_WORKER=false node build/worker.js
```

生产环境建议分别使用 systemd、Supervisor 或 aaPanel Node 项目守护：

| 进程 | 命令 | 说明 |
| --- | --- | --- |
| Go Panel | `bin/azure-panel-go` | 生产主入口，监听 `3000`，承载 Web 静态入口和 Go API |
| Node Compat | `node build/index.js` 或 `node build` | 迁移期本地兼容后端，默认监听 `3001` |
| Worker | `node build/worker.js` | 自动补机与订阅检测迁移期执行层 |

`install.sh` 和 `update.sh` 会自动检测 Go 工具链；`GO_PANEL_ENABLED=true` 时会优先使用系统 Go 1.22+，缺失或版本过低时在 Linux 上自动下载安装到项目 `bin/go-toolchain`，并构建 `services/panel` 到 `bin/azure-panel-go`。如需临时退回仅 Node 兼容运行，可显式设置 `ALLOW_NODE_COMPAT_ONLY=1`。`GO_PANEL_NODE_COMPAT_ENABLED=true` 时，尚未迁移到 Go 的旧 API 会转发到本机 Node 兼容后端。

Go 面板提供这些运行时端点：

```text
/api/health
/api/go/status
/v1/replenishment/dispatch
/api/go/replenishment/tasks
/api/go/replenishment/tasks/{operationId}
```

### 7. Nginx 反向代理

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

### 8. 健康检查

```bash
curl http://127.0.0.1:3000/api/health
```

如果返回 `ready=true`，表示 Web 服务和数据库初始化已完成。生产环境中数据库只要端口和账号可连通，即可认为数据库基础连接正常。

## 升级

```bash
cd /www/wwwroot/Azure-Panel
./update.sh
```

如果执行权限丢失：

```bash
cd /www/wwwroot/Azure-Panel
bash update.sh
```

`update.sh` 会执行：

- 拉取 `origin/master`。
- 默认丢弃生产目录本地修改并同步远程代码。
- 修复 `install.sh` / `update.sh` 可执行权限。
- 检查 `.env` 和运行时默认值。
- 检查 MySQL 连接并同步数据库表结构。
- 同步 aaPanel 数据库列表记录。
- 安装或检测 sing-box / Xray。
- 安装 npm 依赖。
- 构建 Web 与 Worker。
- 裁剪生产依赖。
- 清理构建缓存和临时文件，降低磁盘与运行内存压力。
- 重启 aaPanel Node 项目或 Supervisor 进程。
- 执行健康检查。

如果生产目录有你手动改过的代码，并且不想被覆盖，可以临时使用：

```bash
SKIP_GIT_RESET=1 ./update.sh
```

不建议长期在生产目录直接改源码，推荐在本地提交后再推送到仓库，由 `update.sh` 拉取部署。

## 关键环境变量

| 变量 | 说明 |
| --- | --- |
| `SECRET_KEY` | JWT 签名密钥，生产必须改成强随机字符串 |
| `ENCRYPTION_KEY` | 服务端敏感信息加密密钥，生产必须改成强随机字符串 |
| `DB_DRIVER` | `mysql` 或 `sqlite` |
| `SQLITE_PATH` | SQLite 数据库路径 |
| `MYSQL_HOST` | MySQL 主机 |
| `MYSQL_PORT` | MySQL 端口 |
| `MYSQL_USER` | MySQL 用户 |
| `MYSQL_PASSWORD` | MySQL 密码 |
| `MYSQL_DATABASE` | MySQL 数据库名 |
| `HOST` | Web 监听地址 |
| `PORT` | Web 监听端口 |
| `ENABLE_EMBEDDED_WORKER` | 是否在 Web 进程内嵌 Worker，生产建议 `false` |
| `WORKER_INTERVAL_SECONDS` | Worker 基础轮询间隔，默认 30 |
| `NODE_MAX_OLD_SPACE_SIZE` | Node V8 内存上限，低内存服务器建议 128-256 |
| `GO_PANEL_ENABLED` | 是否启用 Go 主面板，默认 `true` |
| `GO_PANEL_URL` | Go 主面板本地地址，默认 `http://127.0.0.1:3000` |
| `GO_PANEL_NODE_COMPAT_ENABLED` | 是否启用 Node 兼容后端转发，迁移期默认 `true` |
| `GO_PANEL_NODE_COMPAT_URL` | Node 兼容后端地址，默认 `http://127.0.0.1:3001` |
| `GO_PANEL_SUBMIT_DEADLINE_SECONDS` | Go 补机调度提交预算，默认 30 秒；Azure VM 最终就绪仍取决于 Azure ARM 长轮询 |
| `GO_PANEL_QUEUE_LIMIT` | Go 补机调度内存队列保留数量，默认 128 |
| `SING_BOX_BIN` | 手动指定 sing-box 可执行文件路径 |
| `XRAY_BIN` | 手动指定 Xray 可执行文件路径 |
| `MANAGED_PROXY_DIR` | 托管代理核心运行配置目录 |
| `AZURE_PANEL_ADMIN_EMAILS` | 指定管理员邮箱，多个用逗号或空格分隔 |
| `ADMIN_EMAILS` | 兼容管理员邮箱变量 |

## Azure 权限要求

添加 Azure 账号需要 Service Principal 的三项信息：

- Tenant ID
- Client ID
- Client Secret

账号还必须能访问目标 Subscription。根据使用功能，至少需要以下权限：

- 查询订阅、区域、资源、规格、配额、镜像。
- 注册常用 Provider。
- 创建和删除资源组。
- 创建、更新、删除 VM、磁盘、网卡。
- 创建、更新、删除 Public IP。
- 创建和更新 VNet、Subnet。
- 创建和更新 NSG 防火墙规则。
- 创建 IPv4 / IPv6 公网地址。
- 可选：创建和绑定 Azure DDoS Protection Plan。

如果使用自动补机，号池里的补机账号也必须具备创建 VM 和网络资源的权限。启用加速网络时，所选 VM 规格和区域必须支持 Azure Accelerated Networking，否则 Azure API 可能返回创建失败。

## 使用方法

### 1. 初始化管理员

部署完成后打开面板域名，注册第一个用户。第一个用户会自动成为管理员。也可以在 `.env` 中配置管理员邮箱：

```env
AZURE_PANEL_ADMIN_EMAILS=admin@example.com
```

### 2. 配置 Telegram 通知

进入「通知设置」：

1. 填写 Bot Token。
2. 填写个人 UID / Chat ID。
3. 可选填写群组或频道 Chat ID。
4. 点击测试，确认机器人能发送消息。

如果需要群通知，请先把机器人拉入目标群，并确认填写的是群 Chat ID。

### 3. 添加代理

进入「代理配置」：

1. 可手动添加 HTTP / SOCKS5。
2. 可粘贴 `host:port:user:pass` 格式自动识别。
3. 可填写代理 API 地址批量导入。
4. 可粘贴 VLESS 分享链接并选择 sing-box / Xray 托管核心。
5. 添加后执行测活，无效代理可以删除。

自动补机时，系统会优先使用账号绑定代理；绑定代理不可用时，会从可用 HTTP/SOCKS 代理池中切换。

### 4. 添加 Azure 账号

进入「Azure 号池」：

1. 填写 Tenant ID、Client ID、Client Secret。
2. 可使用快速识别框粘贴账号资料。
3. 可绑定代理。
4. 保存时会验证 Azure 凭据和代理出站。
5. 可手动检测账号订阅状态。
6. 可检测账号池剩余数量并发送通知。

### 5. 创建 VM

进入「VM 管理」：

1. 手动选择 Azure 账号。
2. 选择代理模式。
3. 加载官方 API 返回的区域。
4. 选择实例规格。
5. 选择系统镜像。
6. 设置管理员用户名和随机密码。
7. 可选启用 IPv6、加速网络、DDoS 防护、UserData。
8. 点击创建，页面会弹出创建进度窗口。
9. 创建完成后可在 VM 管理中查看 IPv4 / IPv6。

创建 VM 时会同步创建 NSG，并默认放行 `0-65535` 全部端口。

### 6. 更换 IPv4

进入「VM 管理」并选择目标 VM：

1. 点击更换 IPv4。
2. 系统先创建新的 IPv4 Public IP。
3. 新 IP 创建成功后解绑旧 IP。
4. 将新 IP 绑定到网卡。
5. 删除旧 IP。
6. 同步 DNS 和防火墙策略。

刷 IPv4 段时流程类似，只是会按指定前缀循环尝试，页面会显示刷到过的完整 IP 和命中结果。

### 7. 配置 DNS

进入「DNS 管理」：

1. 添加彩虹 DNS 面板配置。
2. 填写面板地址、账号、密码、UID/API 信息。
3. 测试连接。
4. 拉取域名和记录。
5. 创建 DNS 绑定，指定域名、子域名、线路、TTL 等。

DNS 绑定可用于 VM 创建后、自动补机成功后、换 IPv4 或刷 IPv4 段成功后的自动解析同步。

### 8. 配置自动补机策略

进入「自动补机」：

1. 选择用于订阅状态检测的当前账号。
2. 选择补机区域。
3. 选择补机实例规格。
4. 选择安装系统。
5. 填写 VM 名称前缀、管理员用户名、管理员密码。
6. 可填写 UserData。
7. 可开启 IPv6。
8. 可开启 Azure 加速网络。
9. 可开启 Azure DDoS 防护计划。
10. 填写 IPv4 前缀，默认 `85.211`。
11. 填写最大刷 IP 次数，默认 30。
12. 选择 DNS 绑定，这是自动补机成功后同步解析的强制配置。
13. 选择补机账号顺序，默认按加入 Azure 号池时间。
14. 保存策略。

策略保存后，Worker 默认每 30 秒检测一次正在使用账号的订阅状态。检测到异常状态时立即触发补机。补机成功后会发送通知、同步 DNS、删除异常账号并切换监控账号。

### 9. 查看日志

进入「执行日志」：

1. 查看 VM 创建、补机、换 IP、刷 IP、DNS、防火墙、账号检测等日志。
2. 所有时间按北京时间 UTC+8 展示。
3. 可一键导出日志用于排查。

### 10. 管理用户

管理员进入「管理员后台」：

1. 查看所有用户和资源统计。
2. 创建新用户。
3. 禁用或启用用户。
4. 升级或降级管理员。
5. 批量删除用户。
6. 查看非管理员用户脱敏详情。

## 常见问题

### aaPanel 后台看不到 MySQL 数据库

`install.sh` 和 `update.sh` 会同步 aaPanel 数据库列表记录。如果 aaPanel 后台仍看不到：

1. 确认 `.env` 中 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_DATABASE` 正确。
2. 确认 MySQL 端口可连接。
3. 重新执行 `./update.sh`。
4. 查看 `deploy/aapanel/generated/db-credentials.txt` 中的数据库凭据。

### 健康检查返回 503 initializing

通常表示 Web 服务已经启动，但数据库初始化或 schema 检查仍未完成。请检查：

1. MySQL 是否可连接。
2. `.env` 数据库配置是否正确。
3. 是否有多个 Web 进程同时初始化 schema。
4. aaPanel Node 项目日志是否有 MySQL 超时或权限错误。

### update.sh 后内存占用偏高

`update.sh` 已内置生产依赖裁剪、构建缓存清理、临时目录清理和可选 drop caches。建议：

1. 生产环境设置 `ENABLE_EMBEDDED_WORKER=false`。
2. Web 和 Worker 分开运行。
3. 设置 `NODE_MAX_OLD_SPACE_SIZE=192` 或更低/更高的合适值。
4. 确认旧的 Node 项目进程没有重复残留。

### Xray 或 sing-box 下载失败

可以手动下载核心，并在 `.env` 指定路径：

```env
SING_BOX_BIN=/www/wwwroot/Azure-Panel/bin/sing-box
XRAY_BIN=/www/wwwroot/Azure-Panel/bin/xray
```

然后执行：

```bash
./update.sh
```

### Azure Public IP 创建失败

常见原因包括：

- 当前区域 Public IP 容量不足。
- 订阅 Public IP 配额不足。
- 订阅或策略限制。
- `Microsoft.Network` Provider 状态异常。
- 代理出站不稳定导致 Azure 长轮询失败。

可以更换区域、切换代理、检查配额，或稍后重试。

### 加速网络开启失败

Azure 加速网络要求实例规格、镜像、区域和网卡配置支持。若所选规格不支持，创建 VM 可能失败。建议先在 Azure 官方规格信息中确认支持情况，或关闭该选项后重试。

### DDoS 防护计划创建失败

DDoS Protection Plan 可能受订阅权限、区域、配额或策略限制影响。当前创建流程会记录失败原因；如果不是强制需求，可以关闭策略里的 DDoS 防护选项。

## 常用命令

```bash
npm run check         # Svelte / TypeScript 检查
npm run build:all     # 构建 Web + Worker
npm run start         # 启动 Web
npm run start:worker  # 启动 Worker
./install.sh          # 首次部署
./update.sh           # 后续升级
```

## 安全建议

- 生产环境必须修改 `SECRET_KEY` 和 `ENCRYPTION_KEY`。
- 不要公开 `.env`、数据库凭据、Azure Client Secret、Telegram Bot Token、DNS 面板密码。
- 建议使用 HTTPS。
- 建议管理员账号启用 TOTP 二步验证码。
- 建议 Azure Service Principal 只授予实际需要的最小权限。
- 删除用户会删除该用户在面板内保存的数据，请谨慎操作。

## License

MIT

使用 Azure API、代理和 DNS 自动化能力时，请自行确认账号权限、云服务条款、网络合规和数据安全要求。
