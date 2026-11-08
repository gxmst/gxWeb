# 3 号机 Git 部署

2026-11-09 起使用 gxShell CLI 的别名 `3`，更新现有 `/opt/gxWeb` Git checkout。
仓库为 `https://github.com/gxmst/gxWeb.git`，部署分支为 `main`，Compose project 为 `gxweb`。

## 网站入口

3 号机已有 OpenResty 配置 `/usr/local/openresty/nginx/conf/conf.d/gxweb.conf`，
域名为 `web.gxgxg.de5.net` 和 `web.gxmst.cc.cd`，代理到 `127.0.0.1:1881`。
本次沿用现有入口；`web.gxgxg.com` 的 DNS 尚未从 Green 迁移。
3 号机的 443 端口由既有 sing-box 占用，不改变其 VPN 配置。

## 更新方式

先在开发机验证并提交、推送：

```bash
npm run check
npm run test:settings
python -m unittest discover -s tests -v
git add <本次修改的源码和静态资源>
git commit -m "Describe the change"
git push origin main
```

服务器从 GitHub 拉取，不再通过 SFTP 覆盖源码：

```bash
cd /opt/gxWeb
sh tools/deploy.sh main
```

首次取得脚本时先执行 `git pull --ff-only origin main`。脚本拒绝覆盖服务器已修改的跟踪文件，
先构建成功再更新容器，保留爬虫生成的数据、私有 `.env` 和 `crawler-state` 命名卷。
不要使用 `git reset --hard`、`git clean` 或 `docker compose down -v` 更新服务。

Web 绑定 `127.0.0.1:1881`，爬虫以 `1000:1000` 运行。服务器 `.env` 仅保存在本机，
社区默认 300 秒抓取一次。管理密码留空时仅查看抓取频率；启用管理写入前自行设置唯一的
`ADMIN_PASSWORD`（至少 12 个字符），并重新创建 control 容器。不要使用本地 demo 密码。

## 检查与恢复

```bash
docker compose -p gxweb ps
curl -fsS http://127.0.0.1:1881/api/admin/status
curl -fsS http://127.0.0.1:1881/pipeline-status.json
docker compose -p gxweb logs --since=10m spider
git log -1 --oneline
```

首次更新前的服务器提交为 `b7eb9b8`。同机备份目录为 `/opt/gxweb-backups/`，每次备份使用
独立时间戳，保存必要的源码、数据和私有配置用于恢复。备份不进入 Git，不删除旧备份。
若新版本无法运行，应先停爬虫，再从备份复制到独立恢复目录并用原 Compose project 启动，
避免覆盖现有 checkout 或删除现有数据。
