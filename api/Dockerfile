# Build stage — needs a toolchain because bcrypt is a native module.
FROM node:20-bookworm-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Runtime stage — compiled JS plus production dependencies only.
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Static upload page, served by the API off the same port.
COPY public ./public

# Mount point for the uploads named volume.
RUN mkdir -p /app/uploads

EXPOSE 3000

CMD ["node", "dist/main.js"]
