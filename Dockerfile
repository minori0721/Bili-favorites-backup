# syntax=docker/dockerfile:1

FROM node:18-bullseye-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:18-bullseye-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:18-bullseye-slim AS runner
WORKDIR /app
# Use Tsinghua mirror for better network stability in China
RUN sed -i 's/deb.debian.org/mirrors.tuna.tsinghua.edu.cn/g' /etc/apt/sources.list \
  && sed -i 's/security.debian.org/mirrors.tuna.tsinghua.edu.cn/g' /etc/apt/sources.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg curl unzip ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN set -e; \
  BB_URL=$(curl -fsSL https://api.github.com/repos/nilaoda/BBDown/releases/latest \
    | grep -o "https://github.com/nilaoda/BBDown/releases/download/[^\"]*linux-x64.zip" \
    | head -n 1); \
  if [ -z "$BB_URL" ]; then echo "BBDown download URL not found" >&2; exit 1; fi; \
  curl -fsSL "$BB_URL" -o /tmp/bbdown.zip; \
  unzip -o /tmp/bbdown.zip -d /usr/local/bin; \
  chmod +x /usr/local/bin/BBDown; \
  rm /tmp/bbdown.zip
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
