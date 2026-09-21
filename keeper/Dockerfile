FROM node:22-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY tsconfig.json ./tsconfig.json
COPY src ./src
CMD ["pnpm", "start"]
