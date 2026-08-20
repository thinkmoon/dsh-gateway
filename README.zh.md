# dsh-gateway

DSH Web GUI 的认证反向代理：把远程访问完全变成"本地请求"，让远程体验与本地一致。

DSH 的 web 服务**有意只允许绑定 127.0.0.1**（`dsh web --host 0.0.0.0` 会被拒绝，因为那等于把远程代码执行暴露给网络），且 `/api` 有一层 loopback 信任护栏（校验 `Host` 与 `Origin`）。dsh-gateway 站在这层约束前面：

```
远程浏览器 ──HTTPS(可选)──> dsh-gateway(0.0.0.0:8642, 密码认证)
                               │  Host ← 127.0.0.1:<dshPort>
                               │  Origin ← 剥除
                               ▼
                        DSH web (127.0.0.1:<dshPort>)
```

所有转发请求的 `Host` 被改写为本地目标、`Origin` 被剥除，DSH 的信任护栏因此把每一条远程流量都当成无浏览器标记的本地请求 —— 远程会话与本地打开浏览器没有任何区别。整个链路纯流式转发，不缓冲请求体（DSH 的 `/api` 单请求体上限 160 MiB，大附件上传/下载、SSE 都原样通过），WebSocket upgrade（`/api/events.mux`、`/api/events.host`）做原始 socket 双向隧道。

## 认证

- **浏览器**：访问任意路径未登录 → 302 到内置登录页 → 输入密码 → 下发 HMAC-SHA256 签名的 `HttpOnly; SameSite=Lax` 会话 cookie（默认 7 天，可配），全程无第三方依赖、无外部资源。
- **程序化访问**：`Authorization: Bearer <password>` 直接通过。
- **WebSocket**：upgrade 握手同样受 cookie 保护（浏览器 WebSocket 自动携带 cookie），未认证返回 401。
- 登录接口按 IP 限速（10 次/10 分钟），`next` 参数有 open-redirect 防护，会话 cookie 不会下发到 DSH（转发前从 `Cookie` 中剥离）。

## 安装与使用

gateway 作为 DSH 插件随 `dsh web` 一起启动/退出，无需单独守护进程：

```sh
dsh plugin --profile web add link:/path/to/dsh-gateway
dsh web                      # gateway 自动监听 0.0.0.0:8642
```

插件注入 `webServer` 服务，DSH 监听后自动以真实端口为 target 启动 gateway（`--port 0` 随机端口也能正确跟随）。端口被占用时只禁用 gateway 并记日志，不影响 DSH 本体。插件配置（写在 profile 的 `cordis.patch.yml`）：

```yaml
- id: web-gateway
  config:
    port: 8642
    host: 0.0.0.0
    password: ""        # 留空则走解析顺序
    sessionTtlMs: 604800000
    enabled: true
```

开发：

```sh
pnpm install
pnpm typecheck
pnpm test        # 14 项冒烟测试（含 WS 隧道、Host/Origin 改写断言）
```

密码解析顺序：插件配置 `password` → `$DSH_GATEWAY_PASSWORD` → `~/.dsh-gateway/secret`（首次运行自动生成随机密码并记入日志，文件权限 0600）。

### 部署形态

- **Cloudflare Tunnel（推荐，已有 named tunnel 的场景）**：`cloudflared` 的 service URL 指向 `http://127.0.0.1:8642` 即可，TLS 由边缘完成；`dsh.thinkmoon.cn` 这类域名可直接复用。
- **LAN / VPS 直连**：务必加 TLS —— 在 gateway 前面放一层 Caddy/nginx。明文 HTTP 下密码和 cookie 会裸奔。

## 与 dsh-remote-web-ui 插件的关系

`@linxin666/dsh-remote-web-ui` 是应用层方案（DSH 插件体系内做 pairing/设备管理）；dsh-gateway 是**网络层**方案（传输层反向代理，把整个 web GUI 原样"远程化"）。两者可共存，也可按场景择一。

## 安全注意

- gateway 拥有等同于本地打开 DSH 的全部能力（含 agent 的 bash 等），密码请用强随机值（自动生成的 24 字符密码即可）。
- 不要把 gateway 暴露到公网明文端口。
- 改密码即令所有会话失效（会话签名密钥由密码 scrypt 派生）。

## 许可

MIT
