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
# Optional mirror for CN network. Default keeps Debian official sources for CI stability.
ARG APT_MIRROR=official
RUN if [ "$APT_MIRROR" = "tuna" ]; then \
      sed -i 's|http://deb.debian.org/debian|https://mirrors.tuna.tsinghua.edu.cn/debian|g' /etc/apt/sources.list; \
      sed -i 's|http://security.debian.org/debian-security|https://mirrors.tuna.tsinghua.edu.cn/debian-security|g' /etc/apt/sources.list; \
    fi \
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
