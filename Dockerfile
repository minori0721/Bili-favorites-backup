# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:20-bookworm-slim
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
# Optional mirror for CN network. Default keeps Debian official sources for CI stability.
ARG APT_MIRROR=official
RUN if [ "$APT_MIRROR" = "tuna" ]; then \
      if [ -f /etc/apt/sources.list ]; then \
        sed -i 's|http://deb.debian.org/debian|https://mirrors.tuna.tsinghua.edu.cn/debian|g; s|http://security.debian.org/debian-security|https://mirrors.tuna.tsinghua.edu.cn/debian-security|g' /etc/apt/sources.list; \
      fi; \
      if [ -d /etc/apt/sources.list.d ]; then \
        sed -i 's|http://deb.debian.org/debian|https://mirrors.tuna.tsinghua.edu.cn/debian|g; s|http://security.debian.org/debian-security|https://mirrors.tuna.tsinghua.edu.cn/debian-security|g' /etc/apt/sources.list.d/* 2>/dev/null || true; \
      fi; \
    fi \
  && apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg curl unzip ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ARG BBDOWN_VERSION=1.6.3
ARG BBDOWN_ASSET_NAME=BBDown_1.6.3_20240814_linux-x64.zip
ARG BBDOWN_SHA256=ec233b7d8d40b1cc4447dac05be343f53a757dc605743a8808abaa8e97e5d10e
RUN set -e; \
  if [ "$BBDOWN_VERSION" != "latest" ] && [ -n "$BBDOWN_ASSET_NAME" ]; then \
    BB_URL="https://github.com/nilaoda/BBDown/releases/download/${BBDOWN_VERSION}/${BBDOWN_ASSET_NAME}"; \
  elif [ "$BBDOWN_VERSION" = "latest" ]; then \
    BB_RELEASE_URL=https://api.github.com/repos/nilaoda/BBDown/releases/latest; \
    BB_URL=$(curl --retry 3 --retry-delay 2 -fsSL "$BB_RELEASE_URL" \
      | grep -o "https://github.com/nilaoda/BBDown/releases/download/[^\"]*linux-x64.zip" \
      | head -n 1); \
  else \
    BB_RELEASE_URL="https://api.github.com/repos/nilaoda/BBDown/releases/tags/${BBDOWN_VERSION}"; \
    BB_URL=$(curl --retry 3 --retry-delay 2 -fsSL "$BB_RELEASE_URL" \
      | grep -o "https://github.com/nilaoda/BBDown/releases/download/[^\"]*linux-x64.zip" \
      | head -n 1); \
  fi; \
  if [ -z "$BB_URL" ]; then echo "BBDown download URL not found" >&2; exit 1; fi; \
  curl --retry 3 --retry-delay 2 -fsSL "$BB_URL" -o /tmp/bbdown.zip; \
  if [ -n "$BBDOWN_SHA256" ]; then echo "$BBDOWN_SHA256  /tmp/bbdown.zip" | sha256sum -c -; fi; \
  unzip -o /tmp/bbdown.zip -d /usr/local/bin; \
  chmod +x /usr/local/bin/BBDown; \
  rm /tmp/bbdown.zip
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
