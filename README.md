# gxWeb

一个面向个人主页场景的实时信息工作台。

它把市场快讯、海外媒体 RSS、GitHub / Hacker News / V2EX 科技聚合、天气信息、行情 ticker 和壁纸背景整合到一个轻量前端里，适合部署在个人 VPS 上长期运行。

## Features

- `7x24` 实时资讯流：聚合新浪财经快讯、海外 RSS、科技内容。
- 科技趋势聚合：内置 GitHub、Hacker News、V2EX 热门与新帖抓取。
- 天气与环境滤镜：根据天气切换前端氛围层和粒子效果。
- 实时 ticker：输出前端底部滚动行情条所需的数据。
- 壁纸管理：自动生成前端使用的 `wallpapers.json`。
- Docker 部署友好：前后端分离，适合在 VPS 上常驻运行。

## Stack

- Backend: Python 3.11, `requests`, `feedparser`, `Pillow`
- Frontend: HTML, Tailwind CSS, Vanilla JavaScript
- Runtime: Docker, Docker Compose / `docker compose`, Nginx

## Architecture

项目由两个容器组成：

- `spider`
  负责定时抓取、聚合、翻译、清洗数据，并把结果写入 `public/`
- `web`
  使用 Nginx 直接托管 `public/index.html` 和爬虫生成的数据文件

爬虫会持续更新这些前端依赖文件：

- `public/finance-news.json`
- `public/ticker.json`
- `public/ticker-status.json`
- `public/pipeline-status.json`
- `public/weather.txt`
- `public/wallpapers.json`
- `public/github-tech-cache-v2.json`

## Quick Start

### 1. Clone

```bash
git clone https://github.com/gxmst/gxWeb.git
cd gxWeb
```

### 2. Start

推荐使用新版命令：

```bash
docker compose up -d --build
```

如果你的环境仍然使用旧版独立命令，也可以：

```bash
docker-compose up -d --build
```

### 3. Open

默认端口映射为：

```text
http://localhost:1881
```

如果你部署在 VPS 上，把 `localhost` 换成你的服务器 IP 或域名即可。

## Configuration

`docker-compose.yml` 里当前支持这些环境变量：

- `TZ`
  容器时区，默认使用 `Asia/Shanghai`
- `GITHUB_TOKEN`
  可选。用于提高 GitHub API 稳定性和速率限制表现
- `GITHUB_API_TIMEOUT`
  可选。控制 GitHub API 请求超时时间，默认回退到 `20`
- `TRANSLATE_API_TIMEOUT`
  可选。控制标题翻译 HTTP 请求的读取超时，默认 `15` 秒。
- `PIPELINE_JOB_TIMEOUT_SECONDS`
  可选。单个爬虫任务允许持续运行的最长秒数，默认 `1800`；超时后主进程会非零退出，由容器 restart policy 接管。
- `APP_UID` / `APP_GID`
  Linux 部署时运行 `spider` 的非 root UID/GID，默认均为 `1000`。它们应与宿主机 `public/` 目录的所有者一致，容器才能通过 bind mount 写入数据。

推荐从不含秘密的模板创建本地配置；`.env` 已被 Git 和 Docker build context 排除：

```bash
cp .env.example .env
id -u
id -g
# 把上面两个值分别写入 .env 的 APP_UID / APP_GID
```

如果 `id -u` 返回 `0`，不要把容器也改成 root；保留非零 UID/GID（例如 `1000:1000`），并把 `public/` 的所有权交给该 UID/GID。如果 `public/` 由其他用户创建，也需要先调整目录所有权再启动容器。Docker Desktop 用户通常无需额外修改目录权限。

一个常见做法是先在宿主机设置环境变量，再启动：

```bash
export GITHUB_TOKEN=your_token_here
export GITHUB_API_TIMEOUT=20
docker compose up -d --build
```

如果你是 Windows PowerShell：

```powershell
$env:GITHUB_TOKEN="your_token_here"
$env:GITHUB_API_TIMEOUT="20"
docker compose up -d --build
```

## Frontend Build (Tailwind 预编译)

前端 Tailwind 已从浏览器端运行时（407KB Play CDN）改为**静态预编译**。产物 `public/vendor/app.css`（约 24KB，gzip 后约 6KB）已随仓库提交，**VPS 部署无需任何构建步骤**。

只有当你**改动了 `index.html`、`public/js/` 或 `spider.py` 里的 Tailwind class** 时，才需要在开发机重新生成 CSS：

```bash
npm ci             # 按 package-lock.json 安装精确版本
npm run build:css  # 重新编译出 public/vendor/app.css
npm run check      # 校验 vendor、CSS 产物和 JavaScript 语法
```

开发时也可以用 `npm run watch:css` 自动监听重建。

- Tailwind 配置：`tailwind.config.js`（content 扫描 `public/index.html`、`public/js/` 和 `spider.py`）
- 编译入口：`build/tailwind-input.css`
- `node_modules/` 不提交；`app.css` 必须提交
- DOMPurify 以精确版本记录在 `package.json`；升级版本后运行 `npm run vendor:sync`，并提交 `purify.min.js` 与 source map。`npm run vendor:check` 可只做一致性检查。

## Project Structure

```text
gxWeb/
├─ public/
│  ├─ index.html
│  ├─ favicon.png
│  └─ vendor/
│     ├─ app.css        # Tailwind 预编译产物（提交）
│     ├─ purify.min.js  # 由 npm run vendor:sync 生成
│     └─ purify.min.js.map
├─ .github/
│  ├─ workflows/ci.yml
│  ├─ scripts/          # 生成产物与语法一致性检查
│  └─ tests/            # 基础 Python 工具函数测试
├─ tests/
│  └─ test_spider.py    # 失败路径、last-known-good 与看门狗测试
├─ build/
│  └─ tailwind-input.css
├─ tailwind.config.js
├─ package.json
├─ spider.py
├─ Dockerfile
├─ docker-compose.yml
├─ requirements.txt
└─ README.md
```

## Development Notes

- 前端主文件是 `public/index.html`
- 抓取、聚合、翻译、缓存逻辑都在 `spider.py`
- 当前 Compose 对 `spider` 容器采用按文件挂载，而不是挂整个项目目录：
  - `./spider.py:/app/spider.py:ro`
  - `./requirements.txt:/app/requirements.txt:ro`
  - `./public:/app/public`（爬虫需要写入）
- `web` 容器挂载：
  - `./public:/usr/share/nginx/html:ro`
  - `./nginx.conf:/etc/nginx/conf.d/default.conf:ro`
  - `./security-headers.conf:/etc/nginx/conf.d/security-headers.conf:ro`（被 `nginx.conf` 各 location 用 `include` 引入，缺失会导致 nginx 启动失败）

`public/` 下的静态文件会立即被 Nginx 看到；但 Python 不会热加载已经导入的 `spider.py`。只改爬虫代码并 `git pull` 后，至少需要：

```bash
docker compose restart spider
```

如果改了依赖、Dockerfile、Compose 或 UID/GID，则必须重建并重建容器：

```bash
docker compose up -d --build
```

## Deployment Tips

一个可重复执行的更新与验证流程：

```bash
git pull --ff-only
docker compose up -d --build
docker compose ps
docker compose logs --since=10m spider
curl -fsS http://127.0.0.1:1881/ticker-status.json
curl -fsS http://127.0.0.1:1881/pipeline-status.json
```

`docker compose ps` 会显示容器 health。需要查看完整健康检查结果时：

```bash
docker inspect --format '{{json .State.Health}}' workspace-spider
docker inspect --format '{{json .State.Health}}' workspace-web
```

注意：Docker restart policy 只在容器进程退出时生效，单纯变为 `unhealthy` 不会自动触发重启；应为 health 和 `ticker-status.json` 新鲜度配置外部监控或告警。

- 建议把站点部署在美国或网络质量较好的 VPS 上，GitHub / HN / V2EX 抓取会更稳定。
- 如果 GitHub 聚合偶发失败，优先检查：
  - 服务器是否能访问 `api.github.com`
  - `GITHUB_TOKEN` 是否已配置
  - 本机或容器是否误用了失效代理
- 如果前端数据没有刷新，先看 `spider` 容器日志是否正常写出了 `public/*.json`

## Limitations

- GitHub、V2EX、RSS 等第三方源的可用性取决于外部网络和对方接口状态
- 翻译质量取决于第三方翻译服务
- 当前项目以单文件前端和单脚本爬虫为主，更适合个人站，而不是复杂团队协作场景

## License

本项目更适合作为个人主页 / 学习 / 自用站点使用。

第三方内容版权归对应来源所有，请自行确认公开展示、转载和长期缓存的合规性。
