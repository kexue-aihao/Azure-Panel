#!/www/server/panel/pyenv/bin/python3
# -*- coding: utf-8 -*-
"""
在 aaPanel 中注册 Azure Panel 资源，使其出现在面板「Node 项目」中可管理。

用法:
  python3 register-aapanel-site.py <app_dir> <domain> <port> [project_name]
"""
from __future__ import print_function

import json
import os
import sys
import time


PANEL_PATH = "/www/server/panel"


class MockWs(object):
    """aaPanel create_project 需要 websocket，CLI 模式下用 mock 替代"""

    def send(self, data):
        try:
            obj = json.loads(data)
            msg = obj.get("msg") or obj.get("message") or data
            print("[aapanel] {}".format(msg))
        except Exception:
            print("[aapanel] {}".format(data))

    def close(self):
        pass


def setup_panel_env():
    if not os.path.isdir(PANEL_PATH):
        print("ERROR: aaPanel 未安装 ({})".format(PANEL_PATH))
        return False
    os.chdir(PANEL_PATH)
    class_path = os.path.join(PANEL_PATH, "class")
    if class_path not in sys.path:
        sys.path.insert(0, class_path)
    if PANEL_PATH not in sys.path:
        sys.path.insert(0, PANEL_PATH)
    return True


def detect_nodejs_version():
    base = "/www/server/nvm/versions/node"
    if not os.path.isdir(base):
        return "v20.20.2"
    versions = sorted(os.listdir(base), reverse=True)
    for v in versions:
        if v.startswith("v"):
            return v
    return "v20.20.2"


def build_get(**kwargs):
    import public

    get = public.dict_obj()
    for k, v in kwargs.items():
        setattr(get, k, v)
    get._ws = MockWs()
    get.def_name = "create"
    return get


def parse_project_config(row):
    raw = row.get("project_config") if isinstance(row, dict) else None
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    try:
        return json.loads(raw)
    except Exception:
        return {}


def find_site_by_name(name):
    import public

    return public.M("sites").where("name=?", (name,)).find()


def find_site_by_domain(domain):
    import public

    row = public.M("sites").where("name=?", (domain,)).find()
    if row:
        return row

    for row in public.M("sites").select():
        config = parse_project_config(row)
        domains = config.get("domains") or []
        if domain in domains:
            return row
    return None


def is_node_site(row):
    if not row:
        return False
    config = parse_project_config(row)
    project_type = config.get("project_type") or row.get("project_type")
    return project_type in ("nodejs", "general", "pm2", "node")


def result_ok(res):
    if isinstance(res, dict):
        return bool(res.get("status"))
    return bool(res)


def result_message(res):
    if not isinstance(res, dict):
        return str(res)
    for key in ("msg", "message", "error_msg", "data"):
        if key in res and res[key]:
            return res[key]
    return str(res)


def restart_node_project(mod_module, project_name):
    import public

    get = public.dict_obj()
    get.project_name = project_name
    try:
        res = mod_module.main().restart_project(get)
        if result_ok(res):
            print("[aapanel] 重启成功: {}".format(project_name))
            return True
        print("[aapanel] 重启失败 ({}): {}".format(project_name, result_message(res)))
        return False
    except Exception as exc:
        print("[aapanel] 重启异常 ({}): {}".format(project_name, exc))
        return False


def build_web_env(port):
    return "HOST=127.0.0.1\nPORT={}\nNODE_ENV=production".format(port)


def register_nodejs_web(app_dir, domain, port, project_name, node_version):
    """注册或修复 aaPanel Node.js 项目（Web，npm run start）"""
    from mod.project.nodejs import nodeMod

    existing = find_site_by_name(project_name)
    if existing:
        print("[aapanel] Node 项目已存在，尝试重启: {}".format(project_name))
        return restart_node_project(nodeMod, project_name)

    domain_site = find_site_by_domain(domain)
    if domain_site and is_node_site(domain_site):
        name = domain_site.get("name")
        print("[aapanel] 域名 {} 已绑定 Node 项目 {}，尝试重启".format(domain, name))
        return restart_node_project(nodeMod, name)

    pkg = os.path.join(app_dir, "package.json")
    if not os.path.isfile(pkg):
        print("ERROR: 未找到 package.json")
        return False

    get = build_get(
        project_type="nodejs",
        project_name=project_name,
        project_cwd=app_dir,
        project_script="start",
        run_user="www",
        port=str(port),
        nodejs_version=node_version,
        pkg_manager="npm",
        not_install_pkg=True,
        release_firewall=False,
        is_power_on=True,
        bind_extranet=1 if domain else 0,
        domains=[domain] if domain else [],
        project_ps="Azure Panel Web",
        env=build_web_env(port),
    )

    print("[aapanel] 创建 Node.js 项目: {} ({})".format(project_name, domain))
    try:
        nodeMod.main().create_project(get)
        return True
    except SystemExit:
        pass
    except Exception as exc:
        print("[aapanel] 创建异常: {}".format(exc))

    if find_site_by_name(project_name):
        print("[aapanel] 项目记录已写入，尝试重启修复...")
        return restart_node_project(nodeMod, project_name)

    return False


def register_general_worker(app_dir, port, worker_name, node_version):
    """注册或修复 aaPanel 通用 Node 项目（Worker）"""
    from mod.project.nodejs import generalMod

    worker_file = os.path.join(app_dir, "build", "worker.js")
    if not os.path.isfile(worker_file):
        print("WARN: 未找到 worker.js，跳过 Worker 项目注册")
        return True

    if find_site_by_name(worker_name):
        print("[aapanel] Worker 项目已存在，尝试重启: {}".format(worker_name))
        return restart_node_project(generalMod, worker_name)

    get = build_get(
        project_type="general",
        project_name=worker_name,
        project_cwd=app_dir,
        project_file=worker_file,
        project_args="",
        run_user="www",
        port="",
        nodejs_version=node_version,
        release_firewall=False,
        is_power_on=True,
        bind_extranet=0,
        domains=[],
        project_ps="Azure Panel Worker",
        env="NODE_ENV=production",
    )

    print("[aapanel] 创建 Worker 项目: {}".format(worker_name))
    try:
        generalMod.main().create_project(get)
        return True
    except SystemExit:
        pass
    except Exception as exc:
        print("[aapanel] Worker 创建异常: {}".format(exc))

    if find_site_by_name(worker_name):
        print("[aapanel] Worker 记录已写入，尝试重启修复...")
        return restart_node_project(generalMod, worker_name)

    return False


def verify_local_health(port, retries=8):
    try:
        import urllib.request
    except ImportError:
        return True

    url = "http://127.0.0.1:{}/api/health".format(port)
    for _ in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                if resp.status == 200:
                    print("[aapanel] 健康检查通过: {}".format(url))
                    return True
        except Exception:
            time.sleep(1)
    print("[aapanel] 健康检查未通过: {}".format(url))
    return False


def main():
    if len(sys.argv) < 4:
        print("用法: register-aapanel-site.py <app_dir> <domain> <port> [web_project_name]")
        sys.exit(1)

    app_dir = os.path.abspath(sys.argv[1])
    domain = sys.argv[2].strip()
    port = sys.argv[3].strip()
    web_name = sys.argv[4].strip() if len(sys.argv) > 4 else "Azure-Panel"
    worker_name = os.environ.get("WORKER_PROJECT_NAME", "azure-panel-worker")

    if not domain:
        print("WARN: 未提供域名，跳过 aaPanel 站点注册")
        sys.exit(0)

    if not setup_panel_env():
        sys.exit(1)

    node_version = os.environ.get("NODEJS_VERSION", detect_nodejs_version())
    print("[aapanel] Node 版本: {}".format(node_version))

    web_ok = register_nodejs_web(app_dir, domain, port, web_name, node_version)
    worker_ok = True
    if web_ok:
        worker_ok = register_general_worker(app_dir, port, worker_name, node_version)

    if web_ok and worker_ok and verify_local_health(port):
        print("[aapanel] 站点注册完成，请在 aaPanel → 网站 → Node 项目 中查看")
        sys.exit(0)

    if web_ok and not verify_local_health(port):
        print("[aapanel] 项目已注册但服务未响应，请检查 aaPanel Node 项目日志")
        sys.exit(1)

    sys.exit(1)


if __name__ == "__main__":
    main()
