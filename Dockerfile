# syntax=docker/dockerfile:1

# ---- 依赖层（含 devDependencies，供构建 / 测试 / verify 使用） ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- 生产构建 + 测试编译 ----
FROM deps AS build
COPY tsconfig.json tsconfig.build.json tsconfig.test.json ./
COPY src ./src
COPY test ./test
RUN npm run build && npm run build:test

# ---- verify 一次性服务：运行时执行 生产构建 + 代码测试 + 冒烟，以退出码汇总 ----
FROM deps AS verify
COPY tsconfig.json tsconfig.build.json tsconfig.test.json ./
COPY src ./src
COPY test ./test
COPY verify ./verify
CMD ["sh", "verify/run.sh"]

# ---- 生产运行时（零运行时依赖，非 root 运行，自带健康检查） ----
FROM node:22-alpine AS app
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
