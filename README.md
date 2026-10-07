# 实时剂量看板（dose-dashboard）

放射校准实验室的单页实时剂量看板。多台采集器并发上报读数，值班员刷新页面或短暂断线后，每条读数仍恰好累计一次；看板无论经历补发还是快照重置，都收敛到服务端相同的分通道剂量与修订号。

零外部依赖（Node.js ≥ 20 内置 `http` / `fetch` / `node:test`），Docker 构建无需访问 npm 仓库。

## 快速开始

```bash
# 本地开发（源码直接运行）
npm start                 # http://localhost:8080

# 本地完整校验：代码测试 + 生产构建 + 冒烟（需先启动服务）
npm test                  # 单元 / 集成测试
npm run build             # 生产构建 → dist/
npm run smoke             # 冒烟（BASE_URL 可覆盖，默认 http://127.0.0.1:8080）
npm run verify            # 上述三者汇总，退出码非 0 即失败

# Docker（宿主机端口用 APP_PORT 配置，默认 8080）
APP_PORT=9000 docker compose up --build app
# 一次性校验服务：等待 app 健康后运行测试+构建+冒烟，以退出码汇总
docker compose up --build --exit-code-from verify verify
```

## API

### `POST /api/readings`

请求体：`{ "readingId": "r-001", "channel": "CH-1", "dose": 25 }`（`dose` 为正整数 µGy）

| 场景 | 状态码 | 说明 |
| --- | --- | --- |
| 新读数被接纳 | `201` | 返回唯一递增的 `revision` 与 `channelTotal` |
| 相同 readingId + 相同内容 | `200` | 幂等：返回原修订号，不重复累计 |
| 相同 readingId + 不同内容 | `409` | 冲突：状态不变，看板显示「未计入」 |
| 非法剂量（非正整数/非安全整数） | `400` | 状态不变 |
| 累计溢出（超过 2^53-1） | `422` | 状态不变 |

### `GET /api/readings/stream`（SSE）

- 首次订阅：先收到 `event: snapshot`（`id` 为当前修订号，含全量分通道累计），之后只推 `event: delta`，修订号严格连续。
- 断线重连携带 `Last-Event-ID`（浏览器 EventSource 自动携带，也可用 `?lastEventId=`）：补发保留的增量记录。
- 游标过旧（保留窗口已滑过）或来自未来：发送新快照重置客户端。
- 每 15s 发送心跳注释，保持连接活跃。

### 其他

- `GET /api/state`：当前快照 JSON（含 `revision`、`channels`、`retainedFrom`、`logCapacity`）。
- `GET /healthz`：健康检查（Docker `HEALTHCHECK` 与 Compose `service_healthy` 均使用）。

## 一致性设计

- **唯一递增修订**：提交段为同步代码，Node 单线程保证并发接纳不会交错。
- **恰好一次累计**：`readingId → 修订号` 幂等表；重复上报返回原修订，不重复累计。
- **严格连续增量**：SSE 处理器先订阅广播再发快照/补发，全程同步，两者之间不会插入新事件，客户端因此不丢不重。
- **收敛保证**：客户端检测修订缺口即重连；服务端按游标决定补发或快照重置，两条路径都收敛到服务端状态。

## 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 容器内监听端口 |
| `APP_PORT` | `8080` | Compose 宿主机映射端口 |
| `LOG_CAPACITY` | `1000` | 增量日志保留条数（断线补发窗口） |
| `STATIC_DIR` | 自动 | 静态资源目录（默认 `src/public`，构建后为 `dist/public`） |

## 目录结构

```
src/state.js        核心状态存储：修订号、幂等、冲突、溢出、保留日志
src/server.js       HTTP API + SSE + 静态文件
src/public/         单页看板（index.html / app.js / styles.css）
scripts/build.js    生产构建 → dist/（内联资源 + 构建清单）
scripts/smoke.js    冒烟：并发上报、幂等/冲突/溢出、快照/补发/重置收敛
scripts/sse-client.js  测试与冒烟共用的极简 SSE 客户端
test/               node:test 单元与集成测试
verify.sh           汇总 测试+构建+冒烟 的退出码
Dockerfile          多阶段：app（运行时）+ verify（一次性校验）
docker-compose.yml  app 服务（健康检查、可配置端口）+ verify 一次性服务
```
