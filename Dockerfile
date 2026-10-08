FROM node:24-trixie-slim AS frontend-build
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_TURNSTILE_SITE_KEY
RUN test -n "$VITE_SUPABASE_URL" && test -n "$VITE_SUPABASE_PUBLISHABLE_KEY" && test -n "$VITE_TURNSTILE_SITE_KEY" && npm run build

FROM node:24-trixie-slim AS backend-build
WORKDIR /build/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src/ ./src/
RUN npm run build && npm prune --omit=dev

FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
ENV NODE_ENV=production PORT=3001 LANGSMITH_TRACING=false
COPY --from=backend-build /build/backend/package.json ./
COPY --from=backend-build /build/backend/node_modules/ ./node_modules/
COPY --from=backend-build /build/backend/dist/ ./dist/
COPY backend/prompts/ ./prompts/
COPY --from=frontend-build /build/frontend/dist/ /app/frontend/dist/
RUN mkdir generated-music uploaded-audio && chown node:node generated-music uploaded-audio
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:3001/api/health', { signal: AbortSignal.timeout(3000) }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/index.js"]
