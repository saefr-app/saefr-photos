FROM node:24-slim
WORKDIR /app/ml-coordinator
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && mkdir -p /app/state && chown node:node /app/state
COPY --from=contract_schemas / /app/contracts/ml/v1/schemas/
COPY src ./src
COPY test ./test
USER node
ENV ML_STATE_DIR=/app/state ML_API_HOST=0.0.0.0 ML_API_PORT=8002
EXPOSE 8002
CMD ["node", "--experimental-sqlite", "src/main.mjs"]
