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

- Backend: Python 3.11, `requests`, `feedparser`, `Pillow`, `deep-translator`
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

## Project Structure

```text
gxWeb/
├─ public/
│  ├─ index.html
│  └─ favicon.png
├─ spider.py
├─ Dockerfile
├─ docker-compose.yml
├─ requirements.txt
└─ README.md
```

## Development Notes

- 前端主文件是 `public/index.html`
- 抓取、聚合、翻译、缓存逻辑都在 `spider.py`
- 当前 Compose 使用了 volume 挂载：
  - `./:/app`
  - `./public:/usr/share/nginx/html`

这意味着很多代码改动在 `git pull` 后就能直接被容器看到；但如果你改了依赖、镜像、启动方式，还是建议执行：

```bash
docker compose up -d --build
```

## Deployment Tips

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
