# Builds and runs the control plane: Express API + WebSocket dashboard +
# Cloud Tasks enqueueing (routes/reservations.ts, routes/internal.ts).
#
# Build from the REPO ROOT so npm workspaces resolve correctly, e.g.:
#   docker build -f infra/docker/control-plane.Dockerfile -t control-plane .
#
# npm workspaces require every workspace's package.json to be present for
# `npm ci` to resolve the lockfile, so frontend/package.json is copied in
# too even though this image never runs the frontend — its deps end up in
# node_modules as a side effect. Worth revisiting (e.g. per-package
# lockfiles) if image size becomes a problem; not worth the complexity for
# a personal project today.

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

ENV PORT=3001
EXPOSE 3001
CMD ["node", "backend/dist/backend/src/index.js"]
