# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:24-bookworm-slim
ARG BBDOWN_RELEASE=bfb-2.0.0
ARG BBDOWN_COMMIT=fcb895f357df49c45010cefab773025d5d50cf7c
ARG BBDOWN_SHA256=9133c82ae482171ca777d69b850c4d5ed1ce93072e3b8d285c5f4e95749b629d
ARG FFMPEG_RELEASE=ffmpeg-bfb-8.1.2-20260711.1
ARG FFMPEG_VERSION=n8.1.2-22-g94138f6973-20260711
ARG FFMPEG_ARCHIVE=ffmpeg-n8.1.2-22-g94138f6973-linux64-lgpl-8.1.tar.xz
ARG FFMPEG_SHA256=0102dad4a83b266f740a50db7cd5131a8e5266cde8f0937ec3f3cb4a8c3641fa
ARG BFB_BUILD_REF=local
ARG BFB_BUILD_REVISION=

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

FROM debian:bookworm-slim AS ffmpeg
ARG FFMPEG_RELEASE
ARG FFMPEG_ARCHIVE
ARG FFMPEG_SHA256
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /tmp/ffmpeg /out \
  && curl --http1.1 --retry 6 --retry-all-errors --retry-delay 2 -fsSL \
    "https://github.com/minori0721/Bili-favorites-backup/releases/download/${FFMPEG_RELEASE}/${FFMPEG_ARCHIVE}" \
    -o "/tmp/${FFMPEG_ARCHIVE}" \
  && echo "${FFMPEG_SHA256}  /tmp/${FFMPEG_ARCHIVE}" | sha256sum -c - \
  && tar -xJf "/tmp/${FFMPEG_ARCHIVE}" -C /tmp/ffmpeg \
  && install -m 0755 "$(find /tmp/ffmpeg -type f -name ffmpeg -print -quit)" /out/ffmpeg \
  && install -m 0755 "$(find /tmp/ffmpeg -type f -name ffprobe -print -quit)" /out/ffprobe

FROM ${NODE_IMAGE} AS runner
ARG BBDOWN_RELEASE
ARG BBDOWN_COMMIT
ARG FFMPEG_RELEASE
ARG FFMPEG_VERSION
ARG BFB_BUILD_REF
ARG BFB_BUILD_REVISION
WORKDIR /app
ENV BBDOWN_RELEASE=${BBDOWN_RELEASE}
ENV BBDOWN_COMMIT=${BBDOWN_COMMIT}
ENV FFMPEG_RELEASE=${FFMPEG_RELEASE}
ENV FFMPEG_VERSION=${FFMPEG_VERSION}
ENV BFB_BUILD_REF=${BFB_BUILD_REF}
ENV BFB_BUILD_REVISION=${BFB_BUILD_REVISION}
LABEL org.opencontainers.image.bbdown.release=${BBDOWN_RELEASE}
LABEL org.opencontainers.image.bbdown.revision=${BBDOWN_COMMIT}
LABEL org.opencontainers.image.ffmpeg.release=${FFMPEG_RELEASE}
LABEL org.opencontainers.image.ffmpeg.version=${FFMPEG_VERSION}
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
  && apt-get install -y --no-install-recommends aria2 ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=bbdown /out/BBDown /usr/local/bin/BBDown
COPY --from=ffmpeg /out/ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /out/ffprobe /usr/local/bin/ffprobe
RUN ffmpeg -hide_banner -version | head -n 1 \
  && ffprobe -hide_banner -version | head -n 1 \
  && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q 'libwebp'
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
