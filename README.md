# 放射校准实验室 · 实时剂量看板

单页实时剂量看板 + 配套 API。多台采集器并发上报时，值班员刷新或短暂断线后，
每条读数仍**恰好累计一次**；看板无论经历补发还是快照重置，都收敛到与服务端
一致的分通道剂量与修订号。

## 快速开始（Docker Compose）

```bash
docker compose up --build          # 启动看板 + verify 一次性校验服务
# 看板: http://localhost:8080 （宿主机端口可配置）
APP_PORT=9000 docker compose up --build
```

`verify` 服务等待 `app` 健康检查后依次执行：**生产构建 → 代码测试 →
并发上报与断线续接冒烟**，并以退出码汇总（全过 0，任一失败 1）：

```bash
docker compose logs verify
docker inspect dose-dashboard-verify-1 --format '{{.State.ExitCode}}'
```

## 本地开发

```bash
npm ci
npm test                 # 代码测试（编译 + node --test）
npm run build            # 生产构建 -> dist/
npm start                # 启动服务（PORT 默认 8080）
npm run smoke            # 另开终端，对本地服务跑冒烟
npm run verify           # 一键执行 构建 + 测试 + 冒烟（等价于 verify 容器）
```

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/readings` | 上报读数 `{readingId, channel, dose}` |
| `GET` | `/api/readings/stream` | SSE：快照 / 增量 / 补发 / 快照重置 |
| `GET` | `/api/state` | 当前 `{revision, channels, retention, oldestRetainedRevision}` |
| `GET` | `/healthz` | 健康检查 |
| `GET` | `/` | 单页看板 |

### POST /api/readings

- `201` 新读数被接纳，返回 `{revision, total, deduplicated:false}`
- `200` 相同 `readingId` + 相同内容：幂等去重，返回**原修订号**，不重复累计
- `409` 相同 `readingId` + 不同内容：冲突，返回已登记内容，**不计入**
- `400` 非法请求（剂量非正整数安全整数、字段缺失等），状态不变
- `422` 累计剂量超出 `2^53-1`（整数溢出），状态不变

并发接纳由同步存储保证：修订号唯一且严格递增。

### GET /api/readings/stream（SSE）

- 首次订阅：先收到 `event: snapshot`（`id` 即当前修订号，含全量分通道累计），
  之后只收到严格连续的 `event: reading` 增量（携带通道累计值 `total`）。
- 携带 `Last-Event-ID` 重连：游标在保留窗口内时，只补发其后的保留记录。
- 游标过旧（或非法/未来游标）：发送新快照重置客户端。
- 可用 `?fresh=1` 强制忽略 `Last-Event-ID` 重新快照。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 容器内监听端口 |
| `LOG_RETENTION` | `1000`（compose 中 `200`） | SSE 补发日志保留条数 |
| `APP_PORT` | `8080` | compose 宿主机映射端口 |
| `BASE_URL` | `http://127.0.0.1:8080` | 冒烟脚本目标地址 |

## 目录结构

```
src/store.ts      剂量存储：幂等接纳、修订号、保留日志（同步实现，并发安全）
src/server.ts     HTTP 路由 + SSE（快照/补发/重置，握手缓冲保证严格连续）
public/index.html 单页看板（分通道累计、最新修订号、连接状态、冲突面板）
test/             单元测试 + API/SSE 集成测试
verify/smoke.mjs  黑盒冒烟：并发上报、幂等、冲突、溢出、断线续接、收敛
verify/run.sh     verify 服务入口：构建 + 测试 + 冒烟，退出码汇总
Dockerfile        多阶段：deps / build / verify / app（生产运行时）
docker-compose.yml app（健康检查、端口可配）+ verify（等待健康后一次性执行）
```
