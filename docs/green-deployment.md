# Green 部署与微调

> 2026-11-09：gxWeb 已停用，后续开发部署改用 3 号机，见 [3 号机 Git 部署](server3-deployment.md)。
> `/opt/gxweb` 的源码与数据保留。`workspace-spider`、`workspace-web` 已停止，
> Docker restart policy 已改为 `no`，不会随 Docker 重启自动恢复。
> Green 的 Nginx、VPN 与其他服务保持运行。以下内容是原部署记录。

2026-11-08 已通过 gxShell CLI 在 `green` 部署本地工作区版本，入口为
<https://web.gxgxg.com/>。这次直接上传源码和静态文件，服务端目录不是 Git checkout；
本地基于 `b7eb9b8` 的未提交修改也已包含，因此不能在服务器用 `git pull` 更新这版。

## 运行位置

- 项目目录：`/opt/gxweb`，Compose project 为 `gxweb`。
- 容器：`workspace-spider`、`workspace-web`，设置了 `restart: always`。
- Web 仅绑定 `127.0.0.1:1881`，爬虫以 `1000:1000` 运行并写入 `public/`。
- 宿主机 Nginx 配置：`/etc/nginx/sites-available/web.gxgxg.com`。
- HTTPS 由 Green 已有的 SNI 路由转到 `127.0.0.1:8448`，再代理到 `1881`。
- SNI 配置：`/etc/nginx/stream-conf.d/stt-reality.conf`。
  增加路由前的备份为同目录下 `stt-reality.conf.bak-gxweb-20261108-2300`。
- 证书：`/etc/letsencrypt/live/web.gxgxg.com/`，首次证书有效期到 2027-02-06；
  使用既有 Certbot 定时续期和 Nginx reload hook。

## 抓取与登录

NodeSeek 读取 `https://rss.nodeseek.com/`，Linux DO 读取
`https://linux.do/latest.rss`。默认每 600 秒轮询，每站最多取 30 条；
此次实际抓到 NodeSeek 20 条、Linux DO 30 条，NodeSeek 数量受上游 RSS 限制。
Linux DO 在 Green 上对同样请求头的 HTTP/1.1 返回 403、HTTP/2 返回有效 RSS，
所以论坛订阅使用标准 `httpx` HTTP/2 客户端。

无需额外 cron；后台容器自带轮询。浏览器每 30 秒检查本站 JSON，关闭资讯或
进入屏保后暂停浏览器轮询，后台仍持续采集。失败时保留上次成功数据。
只收录公开 RSS，无法保证包含需登录或论坛等级权限的话题。

## 本地微调

运行 `npm run preview`，打开 <http://127.0.0.1:1882/>；示例数据只在内存里生成。
HTML/JS/CSS 修改后刷新即可；改 Tailwind class 后先运行 `npm run build:css`。
设置保存在各自浏览器内；本地预览和线上域名的设置分别保存。

需要用真实资讯微调时，可用 gxShell 的单文件传输下载六个数据文件到
`.local-preview/`，例如在项目根目录运行：

```powershell
& ..\gxshell-cli.exe transfer pull green:/opt/gxweb/public/finance-news.json .\.local-preview\finance-news.json --json
python tools/preview.py --data-dir .local-preview
```

其余数据文件为 `ticker.json`、`ticker-status.json`、`pipeline-status.json`、
`weather.txt`、`wallpapers.json`。真实壁纸也需要其 JSON 引用的图片；只调整布局可用 demo。

## 更新与检查

先在本地完成检查，再通过 gxShell `transfer push` 上传修改的源码/静态文件。
已有文件须明确使用 `--overwrite`；保留服务器 `.env` 与爬虫生成的 `public` 数据。

```bash
docker compose --project-directory /opt/gxweb -p gxweb up -d --build
docker compose --project-directory /opt/gxweb -p gxweb ps
docker compose --project-directory /opt/gxweb -p gxweb logs --since=10m spider
curl -fsS http://127.0.0.1:1881/pipeline-status.json
```

只改静态文件时上传后即可生效；只改 Python 时需重启 spider。依赖、Compose 或
`.env` 改动需用上面的 `up -d --build` 重建/重新创建容器。
改域名 Nginx/SNI 配置时先 `nginx -t`，成功后再 `systemctl reload nginx`。

本次验证：31 项 Python 测试、4 项设置测试与前端产物/语法检查通过；
两个容器 healthy，HTTPS、天气代理、真实社区帖子、控件设置及屏保恢复均通过。
