# Changelog

## 0.5.0

- The section carries its own icon: the Work Status header draws a dial with
  its needle off idle. It used to fall back to OpenChamber's generic
  four-squares glyph, because the app has no built-in icon named `gauge`.
- A shorter idle section: while there is nothing to draw, the curve's band
  closes up instead of leaving a blank strip, and it opens again when a reply
  starts.
- The number says what it is: an idle headline is greyed *and* labelled
  `Last reply`, and the dot goes quiet when the chat has nothing to say.
- A watched chat with nothing to report says `no reply yet` once, in the
  headline, rather than a row of dashes.
- A turn longer than a minute reads as minutes: `2m 5s`, not `250s` — in the
  reply line, the receipt and the time left of a prompt read.
- The prompt reading is called `compacting` when the chat is rewriting its own
  history.
- A wording too long for the headline is read in full in the curve's spot,
  wrapped over its own lines, instead of being cut off beside the number: a
  notice such as an unapproved local service or an unreachable stream, and a
  state that does not fit beside the number.
- The `Last reply` label names only a number that really is the last reply's;
  a turn that is still running shows its own average.
- A too-long model name is what gives way: the line keeps its quantization and
  its cost, which the ellipsis used to eat.

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
