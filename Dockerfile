# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:20-bookworm-slim
ARG BBDOWN_COMMIT=259a5558cee0a349a7ebb60bd31e40c88e5bc1ed
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM mcr.microsoft.com/dotnet/sdk:9.0-bookworm-slim AS bbdown-builder
ARG BBDOWN_COMMIT
WORKDIR /src
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl clang build-essential zlib1g-dev \
  && rm -rf /var/lib/apt/lists/* \
  && curl --retry 3 --retry-delay 2 -fsSL "https://codeload.github.com/nilaoda/BBDown/tar.gz/${BBDOWN_COMMIT}" -o /tmp/bbdown.tar.gz \
  && tar -xzf /tmp/bbdown.tar.gz --strip-components=1 \
  && rm /tmp/bbdown.tar.gz
RUN dotnet publish BBDown -r linux-x64 -c Release -o /out

FROM ${NODE_IMAGE} AS runner
ARG BBDOWN_COMMIT
WORKDIR /app
ENV BBDOWN_COMMIT=${BBDOWN_COMMIT}
LABEL org.opencontainers.image.bbdown.revision=${BBDOWN_COMMIT}
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
  && apt-get install -y --no-install-recommends ffmpeg aria2 ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=bbdown-builder /out/BBDown /usr/local/bin/BBDown
RUN chmod +x /usr/local/bin/BBDown
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
