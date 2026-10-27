# dsh-gateway-mobile

[English](./README.md) | [中文](./README.zh.md)

一个 DSH Host 插件：通过出站的 **Cloudflare Quick Tunnel**，把本机 `dsh web` 会话开放给**已配对的手机**。DSH 始终只监听回环地址；插件运行自己的回环网关（默认 `127.0.0.1:3081`），用每设备会话认证请求并反向代理到 DSH，DSH 的 Cookie 不会离开主机。

状态：**v0.1.0**。Quick Tunnel 是 Cloudflare 的测试/开发设施。

## 快速开始

需要 DSH `0.2.1-rc.2`、Node 22+ 和 cloudflared（支持自动下载）。

全新克隆后先安装依赖并构建一次：

```powershell
npm install
npm run build
```

然后添加插件：

```powershell
dsh plugin --profile web add xxxpath/dsh-gateway-mobile
dsh --profile web --no-open
```

在电脑上打开 `http://127.0.0.1:3081/mobile/admin`（别名 `/admin`），用手机扫码并输入 8 位配对码。管理后台仅限本机回环访问。

## 功能

- Quick Tunnel（HTTP/2）生命周期：重连、启动/停止/重启、状态
- 一次性配对码、每设备 HMAC 会话、滑动续期
- 设备列表：重命名、单台/批量撤销、已撤销记录永久清理、静默过期
- 微信 ClawBot/iLink 通道：扫码后进入待确认状态，必须由本机管理后台允许才连接；完整微信用户 ID 不持久化、不写日志，加密凭证持久化、长轮询接收，和专用 DSH 会话的文本/入站图片对话，以及可在微信中回复的 DSH 审批
- 跨会话微信完成通知：监听所有顶层 DSH 会话和工作区，5 秒合并窗口、单会话 30 秒冷却、全局 10 秒间隔、每小时最多 20 条，并排除微信专用会话
- 跨会话审批通知：任意工作区的审批都可以在微信中回复，审批使用独立的每小时 60 条额度，并有独立审批历史（`weixin-approval-history.json`）
- 管理后台：概览、配对、微信连接、设备、日志、设置
- 手机端打开官方 DSH Web UI；原生聊天 UI 与 `/mobile/ws` 聊天协议暂缓

## 许可证

MIT，见 [LICENSE](./LICENSE)。
