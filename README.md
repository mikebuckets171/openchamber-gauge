# Gauge

A `Gauge` section for OpenChamber's Work Status panel: how fast your chat is
being delivered, what the engine is doing right now, and what the Mac is using.

Gauge reads; it never sends inference, starts a render or changes a setting.

## What it shows

| | |
|---|---|
| headline | the running turn's average speed, greyed when nothing is arriving |
| `last … (measured)` | the finished turn's average — `measured` when the provider reported token counts, `estimated` otherwise |
| `ttft` | time to first token |
| curve | the last 30 s of generation rate, one point per 1.25 s |
| `work` | the heavy job running now: the prompt a local chat is reading (`prompt 40% · 6s left`), or a ComfyUI render (`render · 8 / 20 · 30s · 1 queued`) |
| `memory` | the Mac's memory in use, the total, and the swap in use; the bar turns amber at a kernel warning and red at a critical level |
| `step hit` / `total hit` | cache hit rate of the last settled step (with the change since the one before) and of the whole conversation, sub-sessions included |

Every row is always drawn, at the same height. A reading that is missing is a
dash, never a row that appears and disappears.

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

**The memory** is read from `vm_stat` and `sysctl`: the kernel's own pressure
level, never one inferred from occupancy, and Activity Monitor's "memory used"
(app memory + wired + compressed).

## Install

Open **Settings → Extensions**, paste the folder path of this checkout into
**Folder, ZIP, or URL**, and choose **Add**. Approve the local service. The
extension asks once to add its plugin to OpenCode, which is how the prompt
reading works; without it, everything else still shows.

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
