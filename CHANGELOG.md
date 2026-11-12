# Changelog

## 0.3.0

- The model row now names the model the chat is on, not the one the local
  engine happens to hold. A cloud chat says `MiniMax-M3.1-Flash`; a local one
  says `Qwen3.8-Flash-Next-GSQ-RCO · IQ3_XXS`, with the quantization when the
  engine holds that very model. The local engine's own reading stays on the
  hover, so nothing is lost and nothing is misread.
- The chat's model is taken from the session the status page watches, with the
  model the steps actually ran as the fallback. Two names of one model are
  recognized without a table of provider names.

## 0.2.0

- A `Loaded model` fact: the model the local engine holds in memory, read from
  Splash's own status. It is not the model the chat picked — a route can be
  warm, idle or swapped. A server with no model loaded shows a dash, and a
  reading that grew old is labelled with its age. Nothing is started, stopped
  or loaded to read it.

## 0.1.0

- Initial Gauge Work Status section, built on Live TPS: running chat speed,
  a 30-second curve, first-token time, last-reply speed and cache-hit rates.
- Splash prompt progress through an OpenCode plugin, and a Mac memory and
  pressure reading. The plugin observes existing streaming requests; it does
  not start inference.
- ComfyUI job status and step progress where ComfyUI broadcasts it. Some
  clients receive their own progress privately, so Gauge may show a running
  job without its step count.
- A fixed set of facts, with a dash when a reading is unavailable. No floating
  panel or full page.
- The OpenChamber desktop token is sent only to a verified local server, not
  to an arbitrary address supplied by a page.

Live Splash prompt progress and a real ComfyUI render still need a desktop
check. See the README for installation, measurement details and attribution.
