# --- Build stage ---
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
# Drop devDependencies once the build is done — the runtime image never
# needs TypeScript, eslint, vitest, etc.
RUN npm run build && npm prune --omit=dev

# --- Runtime stage ---
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Non-root by default — reduces blast radius if the container is ever
# compromised. node:20-alpine already ships a "node" user (uid 1000).
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/lib ./lib
COPY --chown=node:node package.json ./
COPY --chown=node:node public ./public
COPY --chown=node:node app.yml ./
COPY --chown=node:node convoy.yaml.example ./

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3000) + '/api/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]
