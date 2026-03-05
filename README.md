# My Vibe Workspace 🚀

一个高性能、高审美且具备极致透明感（Glassmorphism）的金融与生活信息工作站。

## 🌟 核心特性

-   **实时市场快讯**：集成新浪财经 7x24 小时快讯及多家全球顶尖 RSS 新闻源（WSJ, FT, NYT, BBC 等）。
-   **精准行情追踪**：实时展示 A 股、美股、期货及外汇等核心市场行情。
-   **智能天气引擎**：接入 Open-Meteo 数据，支持自动/手动环境滤镜与动态粒子背景。
-   **极致 UI 交互**：全站基于 Tailwind CSS 开发，采用 `backdrop-blur-3xl` 毛玻璃质感与 `tabular-nums` 数据排版。
-   **容器化部署**：支持 Docker Compose 一键启动，包含后端抓取引擎与 Nginx 前端服务。

## 🛠️ 技术栈

-   **Backend**: Python 3.9+ (requests, feedparser)
-   **Frontend**: HTML5, Tailwind CSS, Vanilla JavaScript
-   **Infrastructure**: Nginx, Docker, Docker Compose

## 🚀 快速启动

1.  **克隆项目**
    ```bash
    git clone https://github.com/gxmst/gxWeb.git
    cd gxWeb
    ```

2.  **Docker Compose 部署**
    ```bash
    docker-compose up -d --build
    ```

3.  **访问项目**
    默认访问地址：`http://localhost`

## 📂 项目结构

```text
.
├── public/              # 前端根目录 (Nginx Root)
│   └── index.html      # 前端主页面
├── spider.py           # 后端数据抓取引擎
├── Dockerfile          # 后端镜像定义
├── docker-compose.yml  # 多容器编排
├── requirements.txt    # Python 依赖
└── .gitignore          # Git 忽略文件
```

## ⚖️ 开源协议

本项目仅供学习与个人使用，数据版权归原提供商所有。
