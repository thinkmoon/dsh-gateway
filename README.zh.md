# dsh-gateway

[English](README.md) | [中文](README.zh.md)

[DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) Web GUI 的认证反向代理，以 DSH 插件形式提供。它把远程访问完全变成"本地请求"：远程会话与坐在机器前使用毫无区别。

```sh
dsh plugin --profile web add dsh-gateway   # 或 link:<本地目录>
dsh web                                     # gateway 自动监听 0.0.0.0:8642
```

## 为什么需要它

DSH 的 web 服务**有意只允许绑定 127.0.0.1** —— `dsh web --host 0.0.0.0` 会被直接拒绝，因为把一个能通过 agent 执行任意 shell 命令的 harness 绑到网络接口上，等同于把远程代码执行暴露出去。在此之上，`/api` 层还有一道校验 `Host` 与 `Origin` 的 loopback 信任护栏。

这些都是正确的默认值。但有时候你确实想从手机、另一个房间或另一个大陆访问自己的 harness —— 走真正的 TLS、真正的认证。

dsh-gateway 站在这两层前面：

```
远程浏览器 ──HTTPS──> dsh-gateway (0.0.0.0:8642, 密码认证)
                           │  Host   ← 127.0.0.1:<dshPort>
                           │  Origin ← 剥除
                           ▼
                    DSH web (127.0.0.1:<dshPort>)
```

所有转发请求的 `Host` 被改写为本地目标、`Origin` 被剥除，DSH 的信任护栏因此把每一条远程流量都当成无浏览器标记的本地请求 —— 与在本机打开浏览器无法区分。

## 特性

- **插件原生** —— 随 `dsh web` 一起启动/退出，无额外守护进程、无 supervisor。`--port 0` 动态端口自动跟随。
- **一切流量前有密码门** —— 内置登录页、HMAC-SHA256 签名的 `HttpOnly; SameSite=Lax` 会话 cookie（默认 7 天）、程序化访问用 `Authorization: Bearer <password>`。WebSocket upgrade 同样受会话保护（浏览器自动携带 cookie）。
- **零运行时依赖** —— 纯 Node 核心（`node:http`、`node:crypto`、`node:net`、`node:tls`），无需审计第三方代码。
- **真流式** —— 请求/响应体端到端管道转发，绝不缓冲（DSH 单请求体上限 160 MiB，大附件上传/下载、SSE 原样通过）。
- **WebSocket 隧道** —— upgrade（`/api/events.mux`、`/api/events.host`）以原始 socket 双向隧道桥接，实时 UI 与本地完全一致。
- **默认加固** —— 登录按 IP 限速（10 次/10 分钟）、timing-safe 密码比较、`next` 参数 open-redirect 防护、网关会话 cookie 绝不下发上游、密钥文件 0600。

## 安装

```sh
dsh plugin --profile web add link:/path/to/dsh-gateway
dsh web
```

插件注入 `webServer` 服务，DSH 监听后自动启动 gateway。端口被占用时只禁用 gateway 并记日志，不影响 DSH 本体。

密码解析顺序：插件配置 `password` → `$DSH_GATEWAY_PASSWORD` → `~/.dsh-gateway/secret`（首次运行自动生成随机密码并记入日志，文件权限 0600）。

### 配置

写在 profile 的 `cordis.patch.yml`：

```yaml
- id: web-gateway
  config:
    enabled: true
    host: 0.0.0.0
    port: 8642
    password: ""            # 留空 → 走上文解析顺序
    sessionTtlMs: 604800000 # 7 天
```

### 部署形态

- **Cloudflare Tunnel（推荐）** —— `cloudflared` 的 service URL 指向 `http://127.0.0.1:8642`，TLS 由边缘完成；Caddy/nginx/Traefik 等任意反代同理。
- **LAN / VPS 直连** —— 务必在前面加 TLS（Caddy/nginx 或 tunnel）。明文 HTTP 下密码和会话 cookie 裸奔。

### 端到端验证

测试套件（14 项）覆盖登录流、头部改写（在上游断言：`Host` 已改写、`Origin` 已剥除、网关 cookie 未下发）、流式转发、WebSocket 隧道握手与回显往返、upgrade 的认证门：

```sh
pnpm install
pnpm typecheck
pnpm test
```

## 工作原理

| 关注点 | 做法 |
| --- | --- |
| 让 DSH 接受远程流量 | 代理而非改绑定：DSH 保持 loopback；`Host` 改写为 `127.0.0.1:<port>`、`Origin` 丢弃，loopback 护栏看到的就是纯本地请求 |
| 认证 | scrypt 派生密钥签名带过期时间的会话令牌（`<exp>.<hmac>`），存 `HttpOnly` cookie；脚本用 Bearer 密码 |
| WebSocket | upgrade 在 socket 层隧道：网关向上游重放握手，之后字节双向管道 |
| 生命周期 | 注入 `webServer` 服务的 cordis 插件：监听注册为 effect，fiber 销毁时关闭；端口被占只禁用 gateway，不碰 DSH |

## 与 dsh-remote-web-ui 的关系

`@linxin666/dsh-remote-web-ui` 是应用层方案（DSH 插件体系内的 pairing/设备管理）；dsh-gateway 是**网络层**方案：传输层反向代理，把整个 web GUI 原样远程化，不依赖 DSH 内部实现。两者可共存，按场景择一。

## 安全注意

- gateway 拥有等同于本地 DSH 浏览器会话的全部能力 —— 包括 agent 的 shell 工具。请用强密码（自动生成的即可），并保持前面有 TLS。
- 改密码即令所有会话立即失效（签名密钥由密码 scrypt 派生）。
- 不要把 gateway 的明文端口暴露到公网。

## 环境要求

- Node.js >= 20
- DSH（`@deepseek-ai/dsh`）的 `web` profile

## 许可

MIT
