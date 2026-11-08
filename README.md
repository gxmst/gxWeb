# gxWeb

一个面向个人主页场景的实时信息工作台。

它把市场快讯、海外媒体 RSS、GitHub / Hacker News / V2EX 科技聚合、天气信息、行情 ticker 和壁纸背景整合到一个轻量前端里，适合部署在个人 VPS 上长期运行。

## Features

- `7x24` 实时资讯流：聚合新浪财经快讯、海外 RSS、科技内容。
- 科技趋势聚合：内置 GitHub、Hacker News、V2EX 热门与新帖抓取。
- 天气与环境滤镜：根据天气切换前端氛围层和粒子效果。
- 实时 ticker：输出前端底部滚动行情条所需的数据。
- 壁纸管理：自动生成前端使用的 `wallpapers.json`。
- 壁纸收藏夹：必应每日壁纸只在服务器保留 5 天，前端可把喜欢的整张图存进浏览器 IndexedDB，
  之后长期参与轮换，并在设置中心以缩略图网格管理（收藏是按设备保存的，不随账号同步）。
- 阅读体验：快讯列表带可见滚动条与按时段吸顶小标题；「显示更多」保持原阅读位置不跳动；
  滚动中新到的快讯不打断阅读，改用顶部提示条累计告知。
- 浏览器设置中心：可指定天气城市、调整资讯默认项、管理壁纸收藏、编辑快捷入口和行情顺序，并控制视觉效果与省电模式。
- 控件独立开关：日期、天气、搜索、快捷入口、资讯、行情及控制按钮可分别隐藏；选择保存在当前浏览器。
- 一键屏保：只显示壁纸和时间，退出后恢复原配置。鼠标移动/手机轻触可唤出入口，`Esc` 退出屏保，`S` 打开设置。全部控件关闭时也能唤回设置。
- 社区订阅：接入 NodeSeek 与 Linux DO 官方公开 RSS，按帖子显示标题、摘要、分类和原帖链接；在“社区”分类浏览，在设置里分别开关来源。
- 阅读偏好：紧凑、标准、舒展三档密度与面板不透明度；资讯支持未读筛选和收藏副本，保存在当前浏览器。
- 七天天气：点击天气按钮展开当前城市预报，显示最高/最低温与降水概率。
- 抓取管理：密码解锁后可在前端调整各后台任务的实际频率，配置跨容器重启保留。
- Docker 部署友好：前后端分离，适合在 VPS 上常驻运行。

## Stack

- Backend: Python 3.11, `requests`, `httpx` (HTTP/2 public RSS), `feedparser`, `Pillow`
- Frontend: HTML, Tailwind CSS, Vanilla JavaScript
- Runtime: Docker, Docker Compose / `docker compose`, Nginx

## Architecture

项目由三个容器组成：

- `spider`
  负责定时抓取、聚合、翻译、清洗数据，并把结果写入 `public/`
- `web`
  使用 Nginx 直接托管 `public/index.html` 和爬虫生成的数据文件
- `control`
  提供内部管理 API 和默认天气坐标。仅通过 Web 的同源入口访问，不向宿主机暴露端口。

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
- `WEATHER_LATITUDE` / `WEATHER_LONGITUDE`
  可选。服务端 Open-Meteo 使用的天气坐标，默认 `41.80 / 123.43`（沈阳）。前端不会根据访问 IP 猜城市；用户可在设置中心选择固定城市，选择结果只保存在当前浏览器，使用“服务器默认”时才回到这里配置的坐标。
- `APP_UID` / `APP_GID`
  Linux 部署时运行 `spider` 的非 root UID/GID，默认均为 `1000`。它们应与宿主机 `public/` 目录的所有者一致，容器才能通过 bind mount 写入数据。
- `WEB_BIND_ADDRESS` / `WEB_PORT`
  Web 监听地址和宿主机端口，默认 `0.0.0.0:1881`。由宿主机 Nginx 提供 HTTPS 时，建议设为 `127.0.0.1:1881` 并反向代理到该地址。
- `FORUM_POLL_INTERVAL_SECONDS`
  社区公开 RSS 的初始抓取间隔，默认 `300` 秒，范围 `300–86400` 秒。管理页已保存的频率优先于这个默认值。独立任务抓取两个论坛，不受海外翻译任务阻塞。
- `FORUM_ITEMS_PER_SOURCE`
  每个论坛保留的帖子数量，默认 `30`，范围 `1–50`。修改上述环境变量后需重新创建 spider 容器，单纯 restart 不更新环境变量。
- `ADMIN_PASSWORD`
  管理密码，至少 12 个字符；留空时管理页只能查看频率。生产环境通过 HTTPS 使用，密码仅放在服务器 `.env` 中，不写进前端或浏览器存储。修改密码后需重新创建 `control` 容器，已有会话失效。
- `WEATHER_CITY`
  服务端默认天气坐标的显示名称。请与 `WEATHER_LATITUDE` / `WEATHER_LONGITUDE` 一起配置。

在“设置 → 常规 → 抓取频率”中输入管理密码，分别调整行情与财经快讯、两个论坛、海外 RSS、科技聚合、天气缓存和壁纸列表。论坛等内容源最短 5 分钟，行情最短 1 分钟。保存后调度在 30 秒内读取新配置，以最近一次完成时间计算下一轮；正在抓取的任务正常完成，不并发补跑。新抓取的资讯由下一个行情与财经快讯周期合并发布。健康心跳在等待期间仍每分钟更新。

配置存放在 Docker 命名卷 `crawler-state`，由管理服务写入、爬虫只读，不在公开 `public/` 目录。会话有效期一小时，Cookie 使用 HttpOnly、Secure、SameSite；接口验证同源请求，连续五次错误登录后限制五分钟。网页偏好与资讯收藏则各设备独立保存，不跨设备同步。

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

## 本地预览与 VPS 验证

当前改用 3 号机的 Git checkout 部署，见 [3 号机 Git 部署](docs/server3-deployment.md)。
Green 的 gxWeb 已停用，原记录见 [Green 部署与微调](docs/green-deployment.md)。

在项目根目录运行（已安装 Node 与 `requirements.txt` 中的 Python 依赖）：

```bash
npm run preview
```

打开 `http://127.0.0.1:1882`。示例壁纸、85 条资讯和行情都在内存生成，**不会写入或覆盖 public 中的爬虫数据**，也不会登录论坛。可验证独立开关、全关闭恢复、屏保、社区筛选、移动端与资讯滚动；改 HTML/JS/CSS 后刷新页面，改 Tailwind class 后先运行 `npm run build:css`。停止预览按 `Ctrl+C`。更换端口可运行 `python tools/preview.py --demo --port 1883`。

示例模式的管理密码是 `gxweb-demo-2026`，仅用于本机测试；保存频率写入 `.local-preview/crawler-settings.json`，不会影响 VPS，也不会启动爬虫。七天天气在示例模式中使用模拟数据。生产环境不使用这个演示密码，需自行配置 `ADMIN_PASSWORD`。

本地交互改版：从资讯标题栏或左侧边缘向左拖动可加宽或进入全屏，向右拖动收起；左侧时钟、搜索与快捷入口随可用空间同比缩放。双击拖动区域或点击还原按钮恢复默认。标题与边缘按钮支持左右箭头调整、Enter 全屏、Home 还原，Esc 退出全屏；手机上点击展开按钮进入全屏，正文在面板内滚动。宽度与布局模式保存在当前浏览器中。全屏且视口至少 1024px 时采用双栏，同一行从左至右按时间倒序，时段小标题跨栏；窄屏保留单栏。搜索框只显示当前引擎，点击展开四个选项；聚焦时以胶囊边缘呼吸柔光提示，减少动态或省电模式下使用静态提示。

设置 → 视觉中可分别选择界面、资讯、时钟字体，提供黑体、系统、宋体、文楷和等宽五种预设。中文文楷自托管，首次选择时加载约 7 MB 的 WOFF2；宋体等预设使用设备字体并自动回退。按钮、菜单、时钟不可框选，资讯正文可选择复制，选中颜色随壁纸变化。

环境效果：雨线减少并缩短，落在搜索框、快讯与行情顶部时产生小水珠和涟漪；雪花落到已有雪层上继续堆积，形成局部起伏，调整面板尺寸时按位置保留，最大厚度 18px。切换天气或关闭效果后清除雪层。晴天使用淡暖光，阴天和雾使用缓慢移动的轻层次；普通雨不闪屏，雷暴仅偶发柔和泛光。页面隐藏后暂停动态，减少动态或省电模式下停用粒子。

同一页可调整阅读密度与资讯面板不透明度。资讯区提供全部/未读/收藏切换；全部视图中，资讯充分进入视口并停留 1.8 秒后自动标为已读，也可手动切换。最多留存 200 条收藏副本，原帖子离开上游列表后仍可查看；清除浏览器站点数据会丢失这些本地收藏。

要用 VPS 的真实数据微调，先把 `finance-news.json`、`ticker.json` 等下载到本机 `.local-preview/`（已被 Git 排除），然后：

```bash
python tools/preview.py --data-dir .local-preview
```

只读取指定目录中的六个 JSON/TXT 数据文件，其他文件仍由本机 public 提供。壁纸图片仍需按 JSON 内路径放入本地 public，或先用示例模式调布局；本地预览不是生产 Nginx，不提供真实天气代理。

发布前检查：

```bash
npm run check
npm run test:settings
python -m unittest discover -s tests -v
python -m unittest discover -s .github/tests -v
npm run check:forums
```

最后一条仅测试本机对公开 RSS 的访问与解析，不启动循环、不写应用数据。受本机网络影响，应在 VPS 再验证：

```bash
docker compose up -d --build
docker compose logs --since=10m spider
docker compose exec spider python -c "import spider; print({s: len(spider.fetch_forum_news(s)) for s in spider.FORUM_SOURCES})"
curl -fsS http://127.0.0.1:1881/pipeline-status.json
```

状态面板新增 NodeSeek / Linux DO 两项，记录成功时间、帖子数和失败原因。本地新版默认每 5 分钟拉取一次上游，前端资讯每 30 秒检查本地 JSON；抓取结果由行情快线程在下一个发布周期（通常一分钟内）合并。关闭前端资讯/进入屏保会暂停浏览器轮询，VPS 爬虫继续更新公共数据。

每轮只请求每站一个公开 RSS 地址，不逐帖抓正文，访客数量不会增加论坛抓取次数。每站 5 分钟一轮约为每日 288 次请求；支持 ETag/Last-Modified 条件请求。失败后从 10 分钟开始递增退避，403 从 30 分钟开始，自动退避最多 24 小时；若上游给出更长的 Retry-After，则遵守其等待时间。一个论坛退避不会阻塞另一个。已有服务器环境变量和管理页保存值不会被代码默认值覆盖，部署时需确认实际设置。

论坛看到的是 VPS 出口 IP。机房 IP 的信誉、站点策略或验证仍可能导致 403 / 429，低频订阅不能保证永不拦截。

仅接入游客能看到的公开订阅，RSS 可能有缓存延迟、数量限制或被上游暂时拦截；失败时保留原数据，重启时恢复成功快照。当前不提供登录凭据接入，等级限制话题不会因此出现在公开 JSON 中。

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
