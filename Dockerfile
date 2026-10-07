# syntax=docker/dockerfile:1

########## 应用运行时镜像 ##########
FROM node:20-alpine AS app
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
# 生产构建：生成 dist/（内联前端资源 + 构建清单）
RUN node scripts/build.js
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]

########## 一次性校验服务 ##########
# 等待 app 健康后运行：代码测试 + 生产构建 + 并发上报与断线续接冒烟，
# 以退出码汇总全部结果（0 = 全部通过）。
FROM node:20-alpine AS verify
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY test ./test
COPY scripts ./scripts
COPY verify.sh ./
ENV BASE_URL=http://app:8080
CMD ["sh", "verify.sh"]
