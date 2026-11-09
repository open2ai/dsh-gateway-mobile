# 手机端创建工作区

[English](./mobile-workspace.md) | 中文

DSH 的 **新建工作区**（New Workspace）流程会向宿主请求一个目录。默认情况下，
`directory-picker-auto` 行在启动时选择后端：

- 在有可见显示器的 Windows/macOS 工作站上，它选择 `native`，会在
  **宿主机上打开操作系统文件夹对话框**；
- 在无头、SSH 或远程适配器宿主上，它选择 `browse`，在 **DSH Web UI 内**渲染
  目录浏览器。

网关是反向代理：它把 DSH Web UI 转发给手机，但无法转发 Windows 原生对话框。
当 DSH 在电脑上启动、手机通过网关访问时，DSH 仍会看到回环请求并解析为
`native`。结果是：

> 在手机上点 **新建工作区** 看起来毫无反应；文件夹对话框正在电脑桌面上等待。

## 快速绕过（无需修改配置）

先在电脑上创建或选择工作区。工作区是服务端状态，因此创建后手机可以从侧栏选择
该工作区并继续在其中工作。只有 **创建时的目录选择器** 绑定桌面。

## 允许手机端创建工作区

使用应用内目录浏览器，而不是原生选择器。

### 1. 安装匹配的 browse 后端

版本必须与运行中的 DSH 运行时一致。`dsh 0.2.2-rc.1` 使用
`@deepseek-ai/dsh-host-directory-picker-browse@0.2.2-rc.1`：

```powershell
dsh plugin --profile web add @deepseek-ai/dsh-host-directory-picker-browse@0.2.2-rc.1
```

**不要** 使用不带版本号的包名。npm 的 `latest` tag 目前指向较旧的构建，会被
`dsh 0.2.2-rc.1` 判定为不兼容而拒绝。

该包作为普通 profile 依赖安装；出现 `declares no dsh.bundle` 警告是预期行为。

### 2. 覆盖 picker 行

编辑 profile patch：

```text
%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml
```

按 id 定位的 patch **无法重命名** 已有行：`dsh` 会报
`name mismatch for "directory-picker"` 并跳过。请改为禁用 auto 行并插入
browse 行：

```yaml
# Use the in-app directory browser so remote/mobile clients can create a
# workspace without a native dialog on the host desktop. Disable auto and
# insert the browse backend because a row patch cannot change its name.
- id: directory-picker
  disabled: true
- insert:
    - id: directory-picker-browse
      name: "@deepseek-ai/dsh-host-directory-picker-browse"
```

重启前先校验合成后的配置树：

```powershell
dsh --profile web --dump-config | Select-String 'directory-picker'
```

它应显示 `directory-picker`（auto）为 `disabled: true`，以及一个独立的
`directory-picker-browse` 行。

### 3. 重启 dsh web

`patchReload: live` 可以在 DSH 运行时应用 profile patch 行，但
directory-picker 不是可热插拔服务。它的 `auto` 选择器只在启动时采样一次宿主，
已挂载的 picker 能力在该进程生命周期内保持稳定（“仅启动时”）。因此更换后端
需要重启：

```powershell
dsh --profile web --no-open
```

### 4. 验证

在手机上通过网关打开 DSH UI 并选择 **新建工作区**。DSH 会展示应用内的
**选择工作区目录** 浏览器，而不是宿主文件夹对话框。电脑端也会看到同一个
Web 对话框。

## 安全说明

browse 后端可以列出目录，并在 DSH 宿主进程有权限的任何位置创建子目录。它只应
通过网关的已配对设备会话（以及启用时的 OAuth）访问。不要在未鉴权的情况下暴露
DSH 监听端口或网关。

## 回滚

从 profile patch 中移除 `directory-picker: disabled: true` 条目和插入的
`directory-picker-browse` 行，然后重启 `dsh --profile web --no-open`。已安装的
browse 包可以保留为未使用的依赖，也可以用插件管理器移除。
