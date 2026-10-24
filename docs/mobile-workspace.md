# Mobile workspace creation

DSH's **New Workspace** flow asks the host for a directory. By default the
`directory-picker-auto` row chooses a backend at boot:

- on a Windows/macOS workstation with a visible display it chooses `native`, which
  opens an **operating-system folder dialog on the host**;
- on headless, SSH, or remote-adapter hosts it chooses `browse`, which renders a
  directory browser **inside the DSH web UI**.

The gateway is a reverse proxy: it forwards the DSH web UI to the phone, but it
cannot forward a native Windows dialog. When DSH is launched on the computer and
the phone reaches it through the gateway, DSH still sees a loopback request and
resolves `native`. The result is:

> On the phone, **New Workspace** appears to do nothing; the folder dialog is
> waiting on the computer's desktop.

## Quick workaround (no configuration change)

Create or choose the workspace on the computer first. Workspaces are server-side
state, so after creation the phone can select the workspace from the sidebar and
continue working in it. Only the **creation directory picker** is desktop-bound.

## Enable workspace creation from the phone

Use the in-app directory browser instead of the native chooser.

### 1. Install the matching browse backend

The version must match the running DSH runtime. `dsh 0.2.1-rc.2` uses
`@deepseek-ai/dsh-host-directory-picker-browse@0.2.1-rc.2`:

```powershell
dsh plugin --profile web add @deepseek-ai/dsh-host-directory-picker-browse@0.2.1-rc.2
```

Do **not** use the unversioned package name. The npm `latest` tag currently
points at `0.0.1-rc.1`, which is rejected by `dsh 0.2.1-rc.2` as incompatible.

The package is installed as a plain profile dependency; the warning
`declares no dsh.bundle` is expected.

### 2. Override the picker row

Edit the profile patch:

```text
%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml
```

An id-targeted patch **cannot rename** an existing row: `dsh` reports
`name mismatch for "directory-picker"` and skips it. Disable the auto row and
insert the browse row instead:

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

Validate the composed tree before restarting:

```powershell
dsh --profile web --dump-config | Select-String 'directory-picker'
```

It should show `directory-picker` (auto) as `disabled: true` and a separate
`directory-picker-browse` row.

### 3. Restart dsh web

`patchReload: live` can apply profile patch rows while DSH is running, but the
directory-picker is not a hot-swappable service. Its `auto` chooser samples the
host once at boot and the mounted picker capability stays stable for that
process lifetime ("boot-time only"). Changing the backend therefore requires a
restart:

```powershell
dsh --profile web --no-open
```

### 4. Verify

Open the DSH UI through the gateway on the phone and choose **New Workspace**.
Instead of a host folder dialog, DSH shows the in-app **Select Workspace
Directory** browser. The computer gets the same web dialog.

## Security notes

The browse backend can list directories and create a child directory anywhere
the DSH host process has permission. It is only intended to be reachable through
the gateway's paired-device session (and, when enabled, OAuth). Do not expose the
DSH listener or the gateway without authentication.

## Rollback

Remove the `directory-picker: disabled: true` entry and the inserted
`directory-picker-browse` row from the profile patch, then restart
`dsh --profile web --no-open`. The installed browse package can stay as an unused
dependency, or be removed with the plugin manager.
