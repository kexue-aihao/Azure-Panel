#!/www/server/panel/pyenv/bin/python3
# -*- coding: utf-8 -*-
"""
在 aaPanel 中注册 Azure Panel 资源，使其出现在面板「Node 项目 / 网站」中可管理。

用法:
  python3 register-aapanel-site.py <app_dir> <domain> <port> [project_name]

示例:
  python3 register-aapanel-site.py /www/wwwroot/Azure-Panel az.argoa.org 3000 Azure-Panel
"""
from __future__ import print_function

import json
import os
import sys


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


def project_exists(name):
    import public

    return public.M("sites").where("name=?", (name,)).count() > 0


def register_nodejs_web(app_dir, domain, port, project_name, node_version):
    """注册 aaPanel Node.js 项目（Web，npm run start）"""
    from mod.project.nodejs import nodeMod

    if project_exists(project_name):
        print("[aapanel] Node 项目已存在，跳过: {}".format(project_name))
        return True

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
        env="",
    )

    print("[aapanel] 创建 Node.js 项目: {} ({})".format(project_name, domain))
    try:
        nodeMod.main().create_project(get)
        return True
    except SystemExit:
        return False
    except Exception as exc:
        print("ERROR: Node 项目创建失败: {}".format(exc))
        return False


def register_general_worker(app_dir, port, worker_name, node_version):
    """注册 aaPanel 通用 Node 项目（Worker，build/worker.js）"""
    from mod.project.nodejs import generalMod

    worker_file = os.path.join(app_dir, "build", "worker.js")
    if not os.path.isfile(worker_file):
        print("WARN: 未找到 worker.js，跳过 Worker 项目注册")
        return True

    if project_exists(worker_name):
        print("[aapanel] Worker 项目已存在，跳过: {}".format(worker_name))
        return True

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
        env="",
    )

    print("[aapanel] 创建 Worker 项目: {}".format(worker_name))
    try:
        generalMod.main().create_project(get)
        return True
    except SystemExit:
        return False
    except Exception as exc:
        print("ERROR: Worker 项目创建失败: {}".format(exc))
        return False


def register_site_proxy_fallback(domain, app_dir, port):
    """回退：PHP 网站 + 反向代理（出现在「网站」列表）"""
    import public
    import panelSite

    if project_exists(domain):
        print("[aapanel] 网站已存在: {}".format(domain))
        return True

    site = panelSite.panelSite()
    get = build_get(
        webname=json.dumps({"domain": domain, "domainlist": [], "count": 0}),
        path=app_dir,
        type_id=0,
        type="PHP",
        version="00",
        port="80",
        ps="Azure Panel",
        ftp="false",
        sql="false",
    )
    result = site.AddSite(get)
    print("[aapanel] AddSite:", result)

    proxy_get = build_get(
        sitename=domain,
        proxyname="azure-panel",
        proxydir="/",
        proxysite="http://127.0.0.1:{}".format(port),
        todomain=domain,
        type="0",
        cache="0",
        subfilter="[]",
        advanced="0",
        cachetime="1",
        nocheck="1",
    )
    result = site.CreateProxy(proxy_get)
    print("[aapanel] CreateProxy:", result)
    public.serviceReload()
    return True


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

    ok = register_nodejs_web(app_dir, domain, port, web_name, node_version)
    if not ok:
        print("[aapanel] Node 项目注册失败，尝试网站+反代回退...")
        ok = register_site_proxy_fallback(domain, app_dir, port)

    if ok:
        register_general_worker(app_dir, port, worker_name, node_version)

    if ok:
        print("[aapanel] 站点注册完成，请在 aaPanel → 网站 → Node 项目 中查看")
        sys.exit(0)
    sys.exit(1)


if __name__ == "__main__":
    main()
