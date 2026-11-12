# Changelog

## 0.4.0

- A shorter section: the headline, the curve and three lines (`Last reply`,
  `Model`, `Memory`). A tap on a line opens what is behind it, one line at a
  time, so everything is reachable on a phone, where there is no hover. This
  replaces the grid of always-drawn facts; the section now grows while a line
  is open.
- The reply's receipt: how long the last reply took and what most of that was
  (`48s · mostly writing`), with a bar behind the line that cuts the reply
  into reading, waiting, writing and tools. The reading slice needs a local
  Splash chat and an open Work Status panel while the prompt is read.
- What a cloud chat has cost, beside the model's name. It was already counted
  and never shown. A provider that reports no cost shows a dash.
- Prompt reading and renders are said in the headline instead of on a line of
  their own, and the divider under the curve fills as they progress. A chat's
  own state outranks a render.
- Motion, each once and none of it under reduced motion: the headline number
  glides to a new value, a line slides open, the reply bar fills in when a
  reply ends, and the curve dims out on the left.
- Clean-up: the page no longer starts in Chinese before the host answers or
  asks for a Windows font, labels are no longer in capitals, and the manifest
  reserves the height the section actually has.

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
