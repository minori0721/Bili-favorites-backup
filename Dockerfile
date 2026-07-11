# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:24-bookworm-slim
ARG BBDOWN_RELEASE=bfb-2.0.0
ARG BBDOWN_COMMIT=fcb895f357df49c45010cefab773025d5d50cf7c
ARG BBDOWN_SHA256=9133c82ae482171ca777d69b850c4d5ed1ce93072e3b8d285c5f4e95749b629d

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM debian:bookworm-slim AS bbdown
ARG BBDOWN_RELEASE
ARG BBDOWN_SHA256
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/* \
  && curl --http1.1 --retry 6 --retry-all-errors --retry-delay 2 -fsSL \
    "https://github.com/minori0721/BBDown/releases/download/${BBDOWN_RELEASE}/BBDown_linux-x64.zip" \
    -o /tmp/BBDown_linux-x64.zip \
  && echo "${BBDOWN_SHA256}  /tmp/BBDown_linux-x64.zip" | sha256sum -c - \
  && unzip -q /tmp/BBDown_linux-x64.zip -d /out \
  && chmod +x /out/BBDown

FROM ${NODE_IMAGE} AS runner
ARG BBDOWN_RELEASE
ARG BBDOWN_COMMIT
WORKDIR /app
ENV BBDOWN_RELEASE=${BBDOWN_RELEASE}
ENV BBDOWN_COMMIT=${BBDOWN_COMMIT}
LABEL org.opencontainers.image.bbdown.release=${BBDOWN_RELEASE}
LABEL org.opencontainers.image.bbdown.revision=${BBDOWN_COMMIT}
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
COPY --from=bbdown /out/BBDown /usr/local/bin/BBDown
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
