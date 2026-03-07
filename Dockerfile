# 使用官方超轻量级的 Python 3.11 镜像
FROM python:3.11-slim
WORKDIR /app

# 先把依赖列表拷进去
COPY requirements.txt .
# 让它动态读取 txt 里的列表去安装
RUN pip install --no-cache-dir -r requirements.txt

# 拷贝代码并启动
COPY spider.py /app/spider.py
CMD ["python", "-u", "spider.py"]
