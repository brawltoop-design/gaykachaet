# GAYкачает — контейнер с Node + ffmpeg + yt-dlp.
# Подходит для Render, Fly.io, Railway, любого VPS с Docker.
FROM node:22-slim

# ffmpeg — для склейки видео+звука; yt-dlp ставим через pip (не зависит от архитектуры).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-pip ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages -U yt-dlp \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Зависимостей npm нет — копируем исходники как есть.
COPY package.json server.js ./
COPY public ./public

ENV NODE_ENV=production
# Хостинг (Render/Fly/Railway) сам подставит свой $PORT; локально — 8787.
EXPOSE 8787

CMD ["node", "server.js"]
