# Gauge

A `Gauge` section for OpenChamber's Work Status panel: how fast your chat is
being delivered, what the engine is doing right now, and what the Mac is using.

Gauge reads; it never sends inference, starts a render or changes a setting.

## What it shows

One card in the Work Status panel: a headline, the last 30 seconds of speed, and
a grid of facts under a hairline.

| | |
|---|---|
| headline | the running turn's average speed, greyed when nothing is arriving; the state (`running tool`, `waiting for permission`) sits on the right |
| curve | the last 30 s of generation rate, one point per 1.25 s |
| `Last reply` | the finished turn's average — `measured` when the provider reported token counts, `estimated` otherwise |
| `First token` | time to first token |
| `Prompt reading` | the prompt a local Splash chat is reading (`40% · 6s left`), or the ComfyUI render running now (`8 / 20 · 30s · 1 queued`) |
| `Loaded model` | the model the local engine holds in memory (`Qwen3.8-Flash-Next-GSQ-RCO · IQ3_XXS`), which is not always the model the chat picked |
| `Memory` | the Mac's memory in use, the total, and the swap in use; the meter turns amber at a kernel warning and red at a critical level |
| `Cache hit` | the last settled step's hit rate with the change since the one before, and the whole conversation's, sub-sessions included |

Every fact is always drawn, at the same height. A reading that is missing is a
dash, never a fact that appears or disappears.

## What it needs

- OpenChamber 2.7.0 or newer (the Splash prompt reading uses the plugin
  OpenChamber adds to the OpenCode it runs)
- OpenCode 2.0.25 or newer for the prompt reading; other versions keep the rest
- Node.js 22 or newer
- macOS for the memory row; ComfyUI (any of 127.0.0.1:18188, :8188 or :8000) for
  the render row

## How it measures

**Speed** is measured from OpenChamber's own event stream: the characters of a
reply as they arrive, divided by the span they cover. There is no tokenizer, so
the live number starts at `characters ÷ 4` and is corrected toward the
provider's own token count as each step settles (`measured` once it has).
Tool-call JSON past 200 characters and any pause longer than a second are left
out of the average.

**The prompt reading** comes from Splash's own `return_progress` frames. A
small plugin inside OpenCode adds Splash's documented `return_progress: true`
option to a streaming Splash request, watches the same response for
`prompt_progress` frames, and writes the counters to
`~/.cache/gauge/prompt-progress`. The service reads that file. No prompt,
reply, header, key or raw session id is written: the session is a hash.

**The render** is read from ComfyUI's own job list (`/api/jobs`). The step
counter appears when ComfyUI broadcasts its progress, which it does for a job
queued without a `client_id`.

**The loaded model** comes from Splash's own status (`/status`). Splash's
launcher writes a `serve-PORT.json` record for every server it starts, so the
service knows which port to ask and which process should answer on it. A record
outlives its server, so each one is checked twice: the process must still be
alive, and the server on that port must report the same process and port. A
server that is stopped, recovering, or that has released its weights says so,
and then the row is a dash. Nothing is started, stopped or loaded to read it.

**The memory** is read from `vm_stat` and `sysctl`: the kernel's own pressure
level, never one inferred from occupancy, and Activity Monitor's "memory used"
(app memory + wired + compressed).

## Connection and local data

Gauge's service reads OpenChamber's local desktop client token from its settings
to connect to the event stream. It sends the token only to the desktop's known
loopback address; on a headless host without a desktop address, a literal
loopback listener must belong to the parent process. An unverified address gets
no token. Hosts using a hostname, a tunnel or an unverifiable listener may need
a different connection. Redirects are not followed.

For a password-protected headless host, the inherited fallback can read a UI
password from OpenChamber's local instance file and use it for that loopback
host. The service runs with your user account's access; it is not sandboxed.
Like Live TPS, it saves bounded session IDs, model identifiers, token counts,
cache totals and speed history in its local state file. It does not save the
content of prompts or replies. The prompt-progress plugin's separate cache
contains hashed identifiers rather than raw session and model IDs.

## Install

Open **Settings → Extensions**, paste this repository's URL into **Folder, ZIP,
or URL**, and choose **Add**:

```
https://github.com/mikebuckets171/openchamber-gauge
```

Approve the local service. The extension asks once to add its plugin to
OpenCode, which is how the prompt reading works; without it, everything else
still shows. The built JavaScript files are in the repository, so a Git install
needs no dependency install and no build.

Then turn **Gauge** on in the chat's **Work Status** panel, under **Choose
sections**.

## Verify

```
npm test          # smoke, regressions, page smoke, cache and the OpenCode plugin
bun test service  # the parsers behind the memory and prompt readings
```

## Credits and licence

Gauge's speed measurement, its curve, its calibration and its cache accounting
come from [Live TPS](https://github.com/wwwzzzxxx/openchamber-live-tps) by
wzx, MIT licensed, with changes: the floating panel is gone, and the Mac,
prompt and render readings are new. The Splash prompt-progress plugin is ported
from [MLX Scope](https://github.com/mikebuckets171/mlx-scope-openchamber)'s
OpenCode helper, MIT licensed, with its chat-delivery observer removed.

Gauge is MIT licensed too. See [LICENSE](LICENSE).
