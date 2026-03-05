# 使用官方超轻量级的 Python 3.11 镜像 (大约只要 50MB)
FROM python:3.11-slim
WORKDIR /app
# 只安装我们现在需要的轻量级库，彻底剔除 playwright
RUN pip install --no-cache-dir requests feedparser
COPY spider.py /app/spider.py
CMD ["python", "-u", "spider.py"]
