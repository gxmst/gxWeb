# 使用官方超轻量级的 Python 3.11 镜像
FROM python:3.11-slim
WORKDIR /app

# 先把依赖列表拷进去
COPY requirements.txt .
# 让它动态读取 txt 里的列表去安装
RUN pip install --no-cache-dir -r requirements.txt

# 拷贝代码，让镜像自包含、可独立 `docker run`（CI、冒烟测试、脱离 compose 的场景都能起）。
# 注：docker-compose.yml 仍会把宿主 ./spider.py bind mount 覆盖这一份，
# 实现"日常靠 git pull 热更新代码"；构建那刻两份必然同源，不存在漂移。
COPY spider.py /app/spider.py

# spider.py 会往 ./public 写 heartbeat.txt / ticker.json / weather.txt / 壁纸等。
# compose 下这里被 ./public bind mount 覆盖；但独立 `docker run` 没有挂载时，
# 预建目录可避免首次写盘因父目录缺失而报错。
RUN mkdir -p /app/public/favorite

CMD ["python", "-u", "spider.py"]
