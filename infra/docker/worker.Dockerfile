# Builds and runs the ephemeral worker: the Cloud Tasks target that waits out
# the remaining lead time and fires exactly one reservation's booking
# pipeline (worker.ts / scheduler/pipeline.ts), then exits.
#
# Build from the REPO ROOT so npm workspaces resolve correctly, e.g.:
#   docker build -f infra/docker/worker.Dockerfile -t worker .
#
# See control-plane.Dockerfile for why frontend/package.json is copied in
# despite this image never using it.

FROM node:20-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY shared/package.json shared/package.json
RUN npm ci

COPY shared shared
COPY backend backend
RUN npm run build --workspace=backend

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY shared/package.json shared/package.json
RUN npm ci --omit=dev

COPY --from=builder /app/backend/dist backend/dist

ENV PORT=8080
EXPOSE 8080
CMD ["node", "backend/dist/backend/src/worker.js"]
