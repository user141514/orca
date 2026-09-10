# OMP proxy environment in Orca PTY launches

Use this note when OMP starts successfully inside Orca but its first model request
hangs or fails while the same OMP installation works from a normal terminal.

The important distinction is between **agent launch** and **agent network
environment**. Orca can create the PTY, start OMP, inject the status extension, and
submit a prompt correctly while the child process still lacks the proxy settings it
needs to reach its provider.

## Symptom pattern

A representative failure looks like this:

1. `orca-sub ... --agent omp` creates a real OMP terminal.
2. The OMP TUI renders normally and shows the selected model/provider.
3. The prompt reaches OMP and the UI enters `Working...`.
4. The first model request never completes, or later reports transport symptoms such
   as an HTML gateway response, `socket closed`, or retry exhaustion.
5. Running bare `omp` from a normal terminal on the same machine works.

Do not treat those transport errors as proof that OMP, the provider, or the status
extension is broken until the child process environment has been compared with a
working launch.

## Working-control method

Compare the nearest working launch with the failing Orca launch before changing
code. Keep the executable and prompt constant, then vary one launch property at a
time.

A real incident was isolated with the following matrix:

| Launch | OMP status extension | Proxy env in OMP | Result |
| --- | --- | --- | --- |
| normal terminal, bare `omp` | no | present | model request completed |
| Orca mission, `omp --extension ...` | yes | absent | remained `Working...` |
| Orca terminal, absolute OMP path | no | absent | remained `Working...` |
| Orca terminal, absolute OMP path | no | present | model request completed |
| normal `orca-sub --agent omp` after configuring Orca proxy settings | yes | present | model request completed |

This comparison rules out the OMP status extension as the primary cause. Removing
`--extension` did not recover the request; restoring the proxy environment did.

## Why the environments differ

A shell-launched OMP inherits the environment of that shell. A GUI-launched Orca
process or its persistent PTY daemon may not have the same `HTTP_PROXY`,
`HTTPS_PROXY`, `ALL_PROXY`, or `NO_PROXY` values as a terminal that was started in a
different session or configured later.

That difference is expected at the process boundary: child processes inherit from
the process that actually spawns them, not from an unrelated terminal that happens
to be open on the same desktop.

For native host-local Orca PTYs, the supported proxy path is the explicit Orca network setting:

- `httpProxyUrl`
- `httpProxyBypassRules`

`src/shared/network-proxy.ts` turns those settings into the standard upper- and
lower-case proxy variables with `buildConfiguredProxyEnv()`. When `httpProxyUrl` is
empty, that function intentionally returns an empty object.

`buildPtyHostEnv()` in `src/main/ipc/pty.ts` applies that configured proxy
environment to native host-local PTY launches. The settings UI writes the same fields
from `src/renderer/src/components/settings/AdvancedNetworkSettingsSection.tsx`, and
`src/main/ipc/settings.ts` normalizes them before persistence. The helper is explicitly
host-local: its contract says it must not be used for SSH-backed PTYs.

Therefore an Orca profile with an empty proxy setting can legitimately produce this
state:

```text
normal shell
  HTTP_PROXY / HTTPS_PROXY / ALL_PROXY = present

Orca process / PTY
  HTTP_PROXY / HTTPS_PROXY / ALL_PROXY = absent

OMP launched by Orca
  HTTP_PROXY / HTTPS_PROXY / ALL_PROXY = absent
```

If the provider is reachable only through the proxy, the OMP request then fails even
though PTY creation and agent startup succeeded.

## Correct remediation boundary

If the native host requires a proxy for OMP provider traffic, configure that proxy in
Orca's Advanced network settings so the existing host-local PTY environment path can
inject it. Do not hard-code a machine-specific proxy address into PTY spawn code.

For example, a local HTTP proxy may be configured as:

```text
HTTP proxy URL: http://127.0.0.1:7897/
Bypass rules: localhost;127.0.0.1;192.168.0.0/16;10.0.0.0/8;172.16.0.0/12;::1;*.lan
```

The address and bypass list above are only an example from one test host. They are
not Orca defaults and must not be copied blindly to other machines.

After the setting is applied, a spawned PTY should receive variables equivalent to:

```text
HTTP_PROXY=http://proxy.example:8080
HTTPS_PROXY=http://proxy.example:8080
ALL_PROXY=http://proxy.example:8080
http_proxy=http://proxy.example:8080
https_proxy=http://proxy.example:8080
all_proxy=http://proxy.example:8080
NO_PROXY=localhost,127.0.0.1,...
no_proxy=localhost,127.0.0.1,...
```

The exact proxy scheme and endpoint come from the configured Orca proxy URL.

## Platform scope

The incident and live A/B tests behind this note were performed on a native Linux
host. The proxy injection described above belongs to Orca's native host-local PTY
path; do not infer that the same environment crosses every execution boundary.

Native Windows and macOS PTYs use the host-local environment assembly path, but each
platform still needs its own process-level verification when debugging a concrete
failure. WSL is a separate guest environment: `wsl.exe` only forwards non-default
Windows variables through its own environment-transfer rules (including `WSLENV`), so
this note does not claim that configured host proxy variables automatically appear in
the Linux guest. SSH is also separate: `buildPtyHostEnv()` is intentionally not used
for an SSH-backed PTY because host-local paths and loopback values are meaningless on
the remote execution host.

The portable rule is therefore **execution-host scoped**: configure and verify the
proxy in the environment that actually launches OMP. Do not copy a desktop-local
loopback proxy into WSL or SSH unless that endpoint is reachable from that execution
environment.

## What not to change first

Do not start by removing Orca's OMP status extension. Orca deliberately wraps OMP in
`src/main/pty/omp-shell-wrapper.ts` so status integration is available, and the
single-variable comparison above showed the same request failure without that
extension when the proxy was still absent.

Do not add provider-specific retry logic to compensate for this environment mismatch.
HTML gateway pages, socket closure, and retry exhaustion are downstream transport
symptoms; retrying a request with the same missing network environment preserves the
root cause.

Do not copy arbitrary environment variables from an unrelated terminal process into
the daemon. For native host-local PTYs, use Orca's persisted, normalized proxy
configuration path. For WSL and SSH, treat the guest or remote host as a separate
execution environment and verify its own proxy path instead of assuming native-host
environment propagation.

## Diagnostic procedure

When a user reports "OMP works manually but fails through Orca", use this order:

1. **Prove the working control.** Run the same OMP installation from the user's normal
   terminal with a trivial prompt.
2. **Prove Orca launch succeeds.** Confirm that Orca creates the OMP process and the
   prompt reaches the TUI.
3. **Compare child environments.** Check proxy variables in the working OMP and the
   Orca-launched OMP. On Linux, `/proc/<pid>/environ` is sufficient for a local
   diagnostic; use platform-native process inspection elsewhere.
4. **Remove one suspected wrapper variable at a time.** If needed, launch the same OMP
   executable without the status extension while keeping the Orca PTY environment
   unchanged.
5. **Restore only the proxy environment.** If the request begins succeeding while the
   other launch properties stay constant, the first divergent state is the PTY
   network environment.
6. **Verify the supported native-host path.** For a native host-local incident,
   configure Orca's proxy setting, then launch OMP again through the normal
   `orca-sub --agent omp` path. Do not accept a manual `env HTTP_PROXY=... omp`
   launch as the final product gate. For WSL or SSH, perform the equivalent gate
   inside the guest or remote execution environment instead.

For the native host-local case, a successful final gate must prove both:

```text
normal native Orca launch -> OMP child contains configured proxy env
normal native Orca launch -> first OMP model request completes
```

## Invariant

The durable invariant is:

> When an explicit Orca HTTP proxy is configured for a native host-local PTY, the
> child must receive the normalized proxy environment built from that setting. An
> empty Orca proxy setting must not be mistaken for evidence that an unrelated
> interactive shell also has no proxy. WSL guests and SSH hosts are separate execution
> environments and require their own propagation or configuration proof.

This invariant is broader than OMP. OMP is a useful probe because a failure occurs at
the first provider request, which makes a missing proxy environment visible quickly.
