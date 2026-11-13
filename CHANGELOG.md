# Changelog

## 1.1.0

A calmer section.

- At rest Gauge is one line: the speed and its state. A tap on it opens three
  lines, a second tap folds them away, and the section always starts folded.
  Nothing else moves it.
- The one line that shows itself on a folded section is Memory, under amber or
  red pressure.
- Each opened line says one thing: `Took 48s`, the model's name, `41.2 GB`. What
  most of the reply was, the cost, the quantization and the total memory moved
  behind their lines. `Took` replaces a second `Last reply` under the headline.
- The divider and the arrows on each line are gone. The progress bar for a
  prompt being read or a render shows under the headline only while one runs.
- The dot is steady while a reply is written; the curve and the number already
  move.
- The section starts at one line's height instead of reserving 200 px and then
  shrinking.
- On a phone, where OpenChamber 2.7.1 shows the section in its Status tab, the
  lines are 44 px tall for a finger. The Mac look is unchanged.
- Built on the 2.7.1 SDK.

## 1.0.1

- A reply of an hour or more reads in hours: `5h 41m`, not `341m`.
- Time a permission or a question sat open is timed as the person's. It was
  never counted as a wait, and a question's own open tool call counted it as
  tools running, so a reply that sat on a question read `mostly tools`. It is now
  outside the receipt, listed after it as `waiting on you`, and when it outweighs
  every slice the line says `mostly waiting on you` over the whole stretch.

## 1.0.0

- Gauge now runs on OpenChamber's own plumbing for extensions. The manifest says
  `provides: ["opencode"]`, and OpenChamber hands the service the address of its
  OpenCode plus a token that names this extension. The service no longer reads a
  desktop client token or a UI password out of OpenChamber's settings, no longer
  scans listening ports to guess where the app is, and sends nothing to an
  address the host did not name. Approving Gauge in **Settings → Extensions** is
  what lets it read your sessions.
- The readings are pushed. The service posts each watched chat's reading to the
  open pages — at most six chats per tick, the chats that have waited longest
  first, so a seventh section open on a seventh chat is served rather than left
  to polling — and it says in the watch whether this host takes what it posts. A
  page that is told no asks on every tick; a page that has heard a reading
  recently does not ask at all. The same numbers either way, and a host that
  will not take the posts is not a broken Gauge.
- The numbers Gauge keeps live in the data folder OpenChamber creates for this
  extension, which survives restarts and updates and is deleted with the
  extension, with room in the file for two servers on one workspace to each keep
  their own share of it instead of taking turns overwriting it. It used to write
  beside the service, inside the installed package: a 1.0 service finds such a
  file, reads it once and removes it, so an existing install keeps its last
  turns, its cache totals and its learned calibration — and a copy it did not
  read is left where it is rather than deleted unread.
- The prompt reading works with any llama.cpp engine, not only Splash. A provider
  named for `llama.cpp`, `llama-server`, `llama-swap` or Splash is asked for
  `return_progress` at once; any other provider on a loopback `/v1` is asked only
  after its own `GET /props` answers with llama.cpp's server properties. The
  probe runs behind the request and never waits for one, it uses no credential
  and never reads one, and LM Studio and Ollama are never asked.
- A stream that ends while a reply is in flight is settled by asking OpenCode
  which sessions it is really running (`GET /api/session/active`, one read per
  reconnect) instead of guessing from how long the gap was: a turn OpenCode still
  has keeps its measurement, and a turn it no longer has is recorded from what
  was measured before the cut, stamped at the moment the stream went down. So a
  three-second cut that swallows a reply's closing events no longer leaves the
  section saying "writing" on a chat that finished, and no longer folds the
  outage into the next reply's time.
- The Memory line is drawn only where a memory reading exists: off a Mac the line
  is not there at all, rather than a row of dashes — including on a page that has
  no chat of its own yet.
- A read that was not allowed says what is missing — `Allow Gauge to read your
  sessions in Settings → Extensions` — in its own words, apart from a service
  that cannot be reached.
- The wire carries less: the live reading is one number (`tps`), a finished turn
  keeps `activeMs` and its time split instead of that plus a wall span, and the
  event counter, the per-turn history route, the stored turn list and the unused
  reasoning-exclusion field are gone. A retry's cost is now unwound from the step
  that reported it.
- Removed: the borrowed-token authentication module, `/history`, and the fields
  nothing read any more.

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
