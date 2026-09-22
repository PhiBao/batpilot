FROM node:22-slim AS build
WORKDIR /app
RUN npm install -g pnpm@11.1.1
COPY package.json pnpm-lock.yaml* tsconfig.json ./
COPY src ./src
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm exec tsc

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=200
RUN npm install -g pnpm@11.1.1
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --ignore-scripts --prod
COPY --from=build /app/dist ./dist
CMD ["node", "dist/index.js"]
