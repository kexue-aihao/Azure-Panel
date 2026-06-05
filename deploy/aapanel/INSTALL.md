# Azure Panel — aaPanel 部署指南

适用于已安装 **Nginx + MySQL 8.0 + Supervisor** 的 aaPanel（宝塔）环境。

## 环境要求

| 组件 | 版本建议 | 用途 |
|------|----------|------|
| Node.js | 20 LTS 或 22 LTS | 运行 SvelteKit 应用 |
| MySQL | 8.0.x（已安装） | 生产数据库 |
| Nginx | 已安装 | 反向代理到 Node |
| Supervisor | 已安装 | 守护 Web + Worker 进程 |
| PHP | 不需要 | 本应用不使用 PHP |

## 一、安装 Node.js

在 aaPanel「软件商店」搜索 **Node.js版本管理器** 或 **PM2**，安装后选择 **Node 20 LTS**。

SSH 验证：

```bash
node -v
npm -v
which node
```

记下 `node` 绝对路径（如 `/usr/bin/node`），后续 Supervisor 配置需使用相同路径。

## 二、一键安装（推荐）

在 aaPanel **终端** 中执行：

```bash
cd /www/wwwroot
curl -fsSL https://raw.githubusercontent.com/kexue-aihao/Azure-Panel/master/install.sh -o install.sh
chmod +x install.sh
sudo ./install.sh
```

或已在项目目录内（通过 Git 拉取后）：

```bash
cd /www/wwwroot/Azure-Panel/Azure-Panel
chmod +x install.sh update.sh
sudo ./install.sh
```

脚本自动完成：拉取/更新代码 → **自动创建数据库和用户** → 生成 `.env` → 导入表结构 → `npm install` → `npm run build:all` → 配置 Supervisor → 健康检查。

> 无需手动在 aaPanel 建库。脚本会通过 MySQL root 自动创建 `azure_panel` 库和用户，密码自动生成并保存到 `deploy/aapanel/generated/db-credentials.txt`。

非交互安装（全自动，含 aaPanel 站点注册）：

```bash
NON_INTERACTIVE=1 DOMAIN=az.argoa.org sudo ./install.sh
```

安装时会自动在 aaPanel **网站 → Node 项目** 中创建：

| 项目名 | 类型 | 说明 |
|--------|------|------|
| `Azure-Panel` | Node.js | Web 前端（`npm run start`，端口 3000） |
| `azure-panel-worker` | 通用 | 补机 Worker（`build/worker.js`） |

注册成功后可在面板内直接：**启停、查看日志、绑定 SSL、管理域名**，无需手动配置 Nginx 反代。

若只需 Supervisor 方式、不在面板注册站点：

```bash
AAPANEL_REGISTER_SITE=0 sudo ./install.sh
```

指定数据库密码：

```bash
NON_INTERACTIVE=1 MYSQL_PASSWORD=你的密码 sudo ./install.sh
```

自定义目录：

```bash
APP_DIR=/www/wwwroot/Azure-Panel/Azure-Panel MYSQL_PASSWORD=xxx sudo ./install.sh
```

## 三、手动上传项目（可选）

将项目上传到例如：

```
/www/wwwroot/azure-panel
```

## 四、创建 MySQL 数据库

1. aaPanel → **数据库** → 添加数据库
   - 库名：`azure_panel`
   - 用户名：`azure_panel`
   - 密码：自行设置
2. 打开 **phpMyAdmin**，选择 `azure_panel` 库
3. 导入本目录下的 `schema.mysql.sql`

## 五、配置环境变量（手动安装时）

```bash
cd /www/wwwroot/azure-panel
cp .env.example .env
nano .env
```

生产环境关键配置：

```env
DB_DRIVER=mysql
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=azure_panel
MYSQL_PASSWORD=你的数据库密码
MYSQL_DATABASE=azure_panel

SECRET_KEY=随机长字符串
ENCRYPTION_KEY=32位随机密钥
WORKER_INTERVAL_SECONDS=60

HOST=127.0.0.1
PORT=3000
ENABLE_EMBEDDED_WORKER=false
```

> `ENABLE_EMBEDDED_WORKER=false` 表示 Web 进程不内嵌补机引擎，由 Supervisor 独立 Worker 负责。

## 六、安装依赖并构建（手动安装时）

```bash
cd /www/wwwroot/azure-panel
npm install
npm run build:all
```

`build:all` 会生成：
- `build/index.js` — Web 服务
- `build/worker.js` — 补机 Worker

## 七、配置 Supervisor（手动安装时）

aaPanel → **软件商店** → **Supervisor** → **设置** → 添加守护进程。

### Web 进程

| 字段 | 值 |
|------|-----|
| 名称 | azure-panel-web |
| 启动命令 | `/usr/bin/node /www/wwwroot/azure-panel/build/index.js` |
| 运行目录 | `/www/wwwroot/azure-panel` |
| 运行用户 | www |

也可直接参考 `supervisor-web.conf`。

### Worker 进程

| 字段 | 值 |
|------|-----|
| 名称 | azure-panel-worker |
| 启动命令 | `/usr/bin/node /www/wwwroot/azure-panel/build/worker.js` |
| 运行目录 | `/www/wwwroot/azure-panel` |
| 运行用户 | www |

Worker 会读取同目录下的 `.env` 文件。

添加后执行 **重载配置** 并 **启动** 两个进程。

## 八、配置 Nginx 网站

> **一键安装且已填写 `DOMAIN` 时无需此步**：脚本会自动注册 aaPanel Node 项目并配置反代。

手动部署时：

1. aaPanel → **网站** → **添加站点**（填写域名）
2. 站点设置 → **配置文件**，在 `server { }` 块内加入反代（参考 `nginx.conf`）：

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

3. 如需 HTTPS，在 aaPanel 站点中申请 SSL 证书即可。

## 九、验证

```bash
# 本地健康检查
curl http://127.0.0.1:3000/api/health

# 查看 Supervisor 日志
tail -f /www/wwwlogs/azure-panel-web.log
tail -f /www/wwwlogs/azure-panel-worker.log
```

浏览器访问你的域名，注册账号后即可使用。

## 十、更新部署

推荐使用项目根目录的一键升级脚本：

```bash
cd /www/wwwroot/azure-panel
chmod +x update.sh
./update.sh
```

脚本会自动完成：`git pull` → `npm install` → `npm run build:all` → 重启 Supervisor → 健康检查。

自定义配置示例：

```bash
APP_DIR=/www/wwwroot/azure-panel \
GIT_BRANCH=master \
./update.sh
```

仅更新代码、不重启进程：

```bash
SKIP_SUPERVISOR=1 ./update.sh
```

手动更新（不使用脚本时）：

```bash
cd /www/wwwroot/azure-panel
git pull
npm install
npm run build:all
# aaPanel Supervisor 中重启 web 和 worker 进程
```

## 架构说明

```
用户浏览器
    ↓
Nginx (aaPanel, :80/:443)
    ↓ 反代
Node Web (Supervisor, 127.0.0.1:3000)
    ↓
MySQL 8.0

Supervisor Worker (独立进程)
    ↓ 定时检查
Azure API（开机 / 补机）
```

## 常见问题

**Q: npm install 编译 better-sqlite3 失败？**  
生产环境使用 MySQL（`DB_DRIVER=mysql`），better-sqlite3 仍会作为依赖安装。若仅 Linux 服务器部署且不用 SQLite，可忽略；若失败，安装 `build-essential`：`yum install -y gcc-c++ make` 或 `apt install -y build-essential`。

**Q: Worker 没有日志？**  
确认 `azure-panel-worker` 进程状态为 RUNNING，并检查 `.env` 中数据库配置是否正确。

**Q: 能否用 PM2 代替 Supervisor？**  
可以，但 aaPanel 已内置 Supervisor，推荐按本文档配置，便于面板统一管理。
