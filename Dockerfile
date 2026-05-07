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
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg curl unzip ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://rclone.org/install.sh | bash
RUN curl -L https://github.com/nilaoda/BBDown/releases/latest/download/BBDown_linux_amd64.zip -o /tmp/bbdown.zip \
  && unzip /tmp/bbdown.zip -d /usr/local/bin \
  && chmod +x /usr/local/bin/BBDown \
  && rm /tmp/bbdown.zip
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
