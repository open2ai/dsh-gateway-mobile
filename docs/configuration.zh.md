# 配置

[English](./configuration.md) | 中文

配置位于 profile 的 `cordis.patch.yml` 中 `gateway-mobile` 行的 `config` 对象。默认值：

```yaml
- id: gateway-mobile
  config:
    enabled: true
    dataDir: ''                     # 默认：$DSH_HOME/gateway-mobile
    gateway:
      host: '127.0.0.1'             # 仅回环
      port: 3091
      publicUrl: ''                 # 可选：Named Tunnel / 自建反向代理
    tunnel:
      enabled: true
      mode: 'quick'                 # quick | named
      domain: ''                    # named：公开主机名
      binaryPath: ''                # cloudflared 路径；空 = PATH/缓存/下载
      autoDownload: true
      version: '2026.10.3'
      sha256: ''                    # 固定下载二进制的哈希
      protocol: 'http2'
      maxRetries: 10
      token: ''                     # named 模式；优先用 CLOUDFLARED_TUNNEL_TOKEN
      metricsPort: 0                # named 健康端口；0 = gateway.port + 1000
      healthIntervalMs: 15000       # named 连接器健康检查间隔
    auth:
      pairingTokenExpiry: 900
      sessionMaxAge: 86400
      requireOAuth: false
      oauthProviders: ['github']
      oauthAllowedUsers: []         # 例如 ['github:octocat']；空 = 允许任意已绑定账号
      githubClientId: ''
      githubClientSecret: ''
      giteeClientId: ''
      giteeClientSecret: ''
    proxy:
      upstream: ''                  # 空 = ctx.webServer.getOrigin()
      wsHeartbeatInterval: 30000
      maxRequestSize: 10485760
      requestTimeoutMs: 0
    security:
      rateLimitWindow: 300
      rateLimitMax: 300
      pairingMaxAttempts: 5
      pairingLockoutDuration: 300
      corsOrigins: []
      trustProxy: true
      secureCookies: 'auto'         # auto | always | never
    device:
      inactiveExpiryDays: 30
      maxDevicesPerUser: 10
    weixin:
      enabled: true
      allowOtherUsers: false        # 默认只有 Bot 所有者能驱动 DSH
      allowedUsers: []              # 额外允许的微信用户哈希
    log:
      level: 'info'
      maxEntries: 100
      maxBytes: 5242880             # gateway.log 达到 5 MB 时轮转
      maxFiles: 3                   # 保留 .1、.2、.3
```

`auth.pairingTokenExpiry` 是一次性配对码 TTL（默认 900 秒）。`auth.sessionMaxAge` 是已配对
设备 cookie 的有效期（默认 86400 秒 = 24 小时，最大可校验到 90 天）。活跃会话在生命周期
过半后轮换 cookie，因此日常使用不需要重新配对；空闲会话正常过期。

这两个值也可以在启动时临时覆盖，无需修改 profile：

```powershell
$env:DSH_GATEWAY_SESSION_MAX_AGE = '604800'   # 7 天
$env:DSH_GATEWAY_PAIRING_TOKEN_EXPIRY = '900' # 15 分钟
dsh web --no-open
```

管理后台的设置页会写入 `<dataDir>/admin-settings.json`；存储的值在下次启动时覆盖 profile
中的会话与配对生命周期配置，并对新签发的 cookie/配对码立即生效。接口见
[api.zh.md](./api.zh.md#local-admin-loopback-only-no-session-required)。

`cloudflared` 的解析顺序：`tunnel.binaryPath` → `CLOUDFLARED_PATH` → `PATH` → 缓存下载
（`tunnel.version`）。自动下载是尽力而为的，未配置固定哈希时会告警；生产环境请设置
`tunnel.binaryPath` 与 `tunnel.sha256`。

## Named Tunnel 健康检查

在 `tunnel.mode: 'named'` 下，管理器会以回环 metrics 监听器启动 cloudflared
（`tunnel.metricsPort`，默认 `gateway.port + 1000`），并轮询其 `/ready` 端点最多 20 秒。
一直未就绪的连接器会让隧道停留在 `degraded` 状态，而不是假装已连接；`/health?deep=1`
报告同一信号。metrics 端点只绑定 `127.0.0.1`。cloudflared 各版本的 `/ready` 语义
**需要验证**——如果默认端口冲突，请显式设置 `tunnel.metricsPort`。

## 微信发送者策略

`weixin.allowOtherUsers` 默认为 `false`：只有审批过扫码登录的微信账号（记录为加盐哈希，
从不落原始 user id）可以驱动 DSH、回答审批或接收完成通知。`weixin.allowedUsers` 可以
把指定的 user id 哈希加入白名单，而不必对所有人开放 Bot。未授权发送者会被拒绝、审计，
并收到一次“未授权”提示。

## OAuth 白名单

当 `auth.oauthAllowedUsers` 非空时，提供方身份必须匹配其中一条（`github:octocat`、
`gitee:some-user`；也接受提供方 user id），否则绑定被拒绝并返回 `4010` / HTTP 403。
为空则保持旧版本的宽松行为。白名单在绑定时校验；收紧白名单不会自动解绑已绑定账号的
设备。

## 运行时开关（无需重启）

管理后台 **设置 → 运行开关** 面板会把这些值写入 `admin-settings.json`，并通过实时
config 立即生效；它们同样会在下次启动时恢复：

| 键 | 含义 |
|---|---|
| `tunnelEnabled` | 立即启动/停止 cloudflared 进程 |
| `weixinEnabled` | 立即启动/停止微信轮询与通知 |
| `logLevel` | `debug` / `info` / `warn` / `error`；立即生效 |
| `proxyRequestTimeoutMs` | DSH 上游超时（`0` = 不限制） |

```http
POST /mobile/api/v1/admin/settings
{ "tunnelEnabled": false, "logLevel": "debug", "proxyRequestTimeoutMs": 15000 }
```

`GET /admin/settings` 会在认证生命周期之外返回 `runtime` 下的这些值，以及热生效字段的
空 `restartRequired` 列表。同一端点仍然接受认证字段（`sessionMaxAge`、
`pairingTokenExpiry`）。

## 日志保留

`log.maxEntries` 限制 `/logs` 使用的内存环大小。`log.maxBytes` 和 `log.maxFiles` 会把
`<dataDir>/gateway.log` 轮转为 `.1` … `.N`；写入是排队的，并在关闭时冲刷。
`log.maxBytes` 必须在 64 KiB 到 1 GiB 之间。

## 密钥轮换

管理后台可以在不重启的情况下轮换 AES-256-GCM/HMAC 密钥。密钥保存在
`<dataDir>/secret-keys.json`（`{version:2, active, keys:[…]}`），最多保留最新的五把，
因此旧密文仍可解密、旧会话 cookie 仍可验签；新 token 使用 active kid。源码树仍接受旧版
`secret.key` 并将其迁移为 `k1`。请在可信网络中执行轮换：端点仅限回环且带 CSRF 保护，
备份 `secret-keys.json` 即备份所有已存密钥材料。
