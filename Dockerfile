FROM python:3.11-slim

ARG APP_UID=1000
ARG APP_GID=1000

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Match the host deploy user's UID/GID by passing APP_UID/APP_GID at build
# time. This keeps the long-running process non-root while allowing writes to
# the ./public bind mount on Linux.
RUN groupadd --gid "${APP_GID}" app \
    && useradd --uid "${APP_UID}" --gid "${APP_GID}" --create-home \
        --shell /usr/sbin/nologin app

COPY --chown=app:app spider.py /app/spider.py

RUN mkdir -p /app/public/favorite \
    && chown -R app:app /app

USER app:app

CMD ["python", "-u", "spider.py"]
