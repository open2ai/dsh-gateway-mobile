# dsh-gateway-mobile

[English](./README.md) | [中文](./README.zh.md)

一个 DSH Host 插件：通过出站 **Cloudflare Quick Tunnel** 访问本机 `dsh web` 会话，支持手机一次性配对，也可选接入 **微信 ClawBot/iLink**。DSH 始终监听回环地址；插件运行自己的回环网关（默认 `127.0.0.1:3081`），不会把 DSH 的 Cookie 暴露出去。

状态：**v0.1.1**。Quick Tunnel 是 Cloudflare 的测试/开发设施。

## 快速开始

需要 DSH `0.2.1-rc.4`、Node 22+ 和 cloudflared（支持自动下载）。

```powershell
npm install
npm run build
dsh plugin --profile web add <本仓库路径>
dsh --profile web --no-open
```

在电脑上打开 `http://127.0.0.1:3081/mobile/admin`，用手机扫码并输入 8 位配对码。管理后台仅限本机回环访问。

## 微信

在管理后台打开 **微信**，生成二维码，用微信扫码，然后在电脑上确认连接。连接后先给 Bot 发一条消息，让它拿到 `context_token`。

之后可以在微信里：

- **审批** — 回复 `Y` 允许，回复 `N` 拒绝。
- **提问** — 回复选项序号、选项文字、自定义文字；多选回复 `1,3`；回复 `跳过` 跳过。
- **计划审核** — 复用同一套提问流程。
- **完成通知** — 在 **设置 → 微信连接与推送** 里开启和调整。默认：合并 5 秒、单会话冷却 60 秒、全局间隔 15 秒、每小时 30 条。

微信有可用入站上下文时，审批和提问走微信；否则交给手机/电脑的 DSH 网页处理。完整微信用户 ID 不持久化、不写日志，Bot token 加密保存；只有本机管理后台能确认扫码登录。

## 功能

- Quick Tunnel（HTTP/2）生命周期：重连、启动/停止/重启、状态
- 一次性配对码、每设备 HMAC 会话、滑动续期
- 设备列表：重命名、撤销、清理、静默过期
- 微信文本/图片对话桥接到专用 DSH 会话
- 微信审批、提问、计划审核、timed 提问迟到回答
- 跨会话完成通知：合并窗口、冷却、全局间隔、每小时上限
- 管理后台：概览、配对、微信、设备、日志、设置
- 手机端打开官方 DSH Web UI

## 许可证

MIT，见 [LICENSE](./LICENSE)。
