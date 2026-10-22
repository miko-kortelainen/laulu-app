# syntax=docker/dockerfile:1
FROM node:24-trixie-slim AS frontend-build
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
ARG VITE_SUPABASE_URL
ARG VITE_SENTRY_DSN
ARG VITE_SENTRY_ENVIRONMENT=production
ARG VITE_SENTRY_RELEASE
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_TURNSTILE_SITE_KEY
ARG VITE_PADDLE_CLIENT_TOKEN
ARG VITE_PADDLE_STARTER_PRICE_ID
ARG VITE_PADDLE_PRO_PRICE_ID
ARG VITE_PADDLE_ULTRA_PRICE_ID
ARG VITE_PADDLE_STARTER_ANNUAL_PRICE_ID
ARG VITE_PADDLE_PRO_ANNUAL_PRICE_ID
ARG VITE_PADDLE_ULTRA_ANNUAL_PRICE_ID
RUN --mount=type=secret,id=SENTRY_AUTH_TOKEN,env=SENTRY_AUTH_TOKEN \
    --mount=type=secret,id=VITE_SUPABASE_URL,env=VITE_SUPABASE_URL \
    --mount=type=secret,id=VITE_SUPABASE_PUBLISHABLE_KEY,env=VITE_SUPABASE_PUBLISHABLE_KEY \
    --mount=type=secret,id=VITE_TURNSTILE_SITE_KEY,env=VITE_TURNSTILE_SITE_KEY \
    --mount=type=secret,id=VITE_SENTRY_DSN,env=VITE_SENTRY_DSN \
    --mount=type=secret,id=VITE_SENTRY_ENVIRONMENT,env=VITE_SENTRY_ENVIRONMENT \
    --mount=type=secret,id=VITE_SENTRY_RELEASE,env=VITE_SENTRY_RELEASE \
    --mount=type=secret,id=VITE_PADDLE_CLIENT_TOKEN,env=VITE_PADDLE_CLIENT_TOKEN \
    --mount=type=secret,id=VITE_PADDLE_STARTER_PRICE_ID,env=VITE_PADDLE_STARTER_PRICE_ID \
    --mount=type=secret,id=VITE_PADDLE_PRO_PRICE_ID,env=VITE_PADDLE_PRO_PRICE_ID \
    --mount=type=secret,id=VITE_PADDLE_ULTRA_PRICE_ID,env=VITE_PADDLE_ULTRA_PRICE_ID \
    --mount=type=secret,id=VITE_PADDLE_STARTER_ANNUAL_PRICE_ID,env=VITE_PADDLE_STARTER_ANNUAL_PRICE_ID \
    --mount=type=secret,id=VITE_PADDLE_PRO_ANNUAL_PRICE_ID,env=VITE_PADDLE_PRO_ANNUAL_PRICE_ID \
    --mount=type=secret,id=VITE_PADDLE_ULTRA_ANNUAL_PRICE_ID,env=VITE_PADDLE_ULTRA_ANNUAL_PRICE_ID \
    test -n "$VITE_SUPABASE_URL" && test -n "$VITE_SUPABASE_PUBLISHABLE_KEY" && test -n "$VITE_TURNSTILE_SITE_KEY" && npm run build

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
COPY backend/src/ ./src/
COPY backend/prompts/ ./prompts/
COPY --from=frontend-build /build/frontend/dist/ /app/frontend/dist/
RUN mkdir generated-music uploaded-audio && chown node:node generated-music uploaded-audio
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:3001/api/health', { signal: AbortSignal.timeout(3000) }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "--enable-source-maps", "--import", "./dist/instrument.js", "dist/index.js"]
