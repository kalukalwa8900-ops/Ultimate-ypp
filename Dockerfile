# Video Renderer Backend — Railway deployment image
#
# Railway's default Nixpacks builder does NOT include ffmpeg, and this
# backend calls the system `ffmpeg` / `ffprobe` binaries directly (see
# src/lib/ffmpeg.js) — it does not use an npm ffmpeg package. Without this
# Dockerfile, every /render job would fail on Railway with
# "Cannot start ffmpeg (ffmpeg): spawn ffmpeg ENOENT".
FROM node:20-bookworm-slim

# Install ffmpeg (bundles ffprobe) from Debian's apt repo.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first so this layer is cached across deploys unless
# package.json / package-lock.json actually change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source
COPY . .

# Railway assigns PORT at runtime and reverse-proxies https traffic to it;
# src/config.js already reads process.env.PORT and binds to 0.0.0.0, so no
# code change is needed here. EXPOSE is just documentation for local `docker run`.
ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "src/index.js"]
