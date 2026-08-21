# Splice Looper for YouTube

Loop just the part of a video you actually want, without leaving the YouTube
tab. A small button sits in YouTube's own player controls; click it to arm
a loop, then drag two points directly on the seek bar to mark where it
starts and ends.

## [Install (unpacked, for personal use)](../../releases/latest)

1. Unzip this folder somewhere permanent (don't delete it after — Chrome
   loads the extension live from these files).
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top right toggle).
4. Click **Load unpacked**, and select the `youtube_looper` folder.
5. Open any YouTube video. You should see a new icon (two arrows forming a
   loop) in the player's bottom-right control row, next to settings/fullscreen,
   aligned with the rest of the row.

## Using it

- **Click the loop icon.** Two small blue dots appear directly on the seek
  bar, spanning a default 5-second window around your current playback
  position, with a translucent blue strip connecting them. The button
  itself lights up blue- looping is live from this point.
- **Drag either dot** to redefine where the loop starts and ends. You can do
  this while the video keeps playing; the loop updates as you drag.
- **Click the loop icon again** to turn it off. The dots disappear and
  playback continues normally past where the loop end used to be.
- The jump itself fades out and back in rather than cutting instantly, to
  soften the jump-cut: video opacity ramps down and back up, and where
  possible so does actual audio gain (via Web Audio, routed through the
  video element). If another extension has already claimed the video's
  audio graph, this falls back to the visual-only fade instead of breaking
  playback. Fade duration is configurable in the popup (see below),
  including 0 for a true instant cut with no pause at all.
- Your marked segment is remembered per-video (via `chrome.storage.local`),
  so reopening the same video later restores where you left the dots, and
  whether the loop was on.

## Settings popup

Click the extension's icon in Chrome's toolbar to open a small settings
panel:

- **Fade duration** — how long the loop-jump fade takes, in ms. Defaults to
  130. Set it to 0 for an instant cut with no pause at all- worth trying
  once you've refined a loop point, since a well-matched seam often doesn't
  need the fade to sound clean, and the fade itself becomes a repeating
  interruption on short loops. Refine's own scan blackout is fixed at 150ms
  regardless of this setting, since that's a one-shot action, not something
  that repeats every loop cycle.
- **Keybinds** — click any keybind button, then press the key you want.
  Esc cancels. Picking a key already in use by another action here is
  blocked with an inline note rather than silently overwriting it.
- Changes apply immediately to any open YouTube tab, no reload needed.
- **Reset to defaults** restores the original fade duration and keybinds.

### Keyboard shortcuts

With the player focused (not typing in a text box). Defaults shown below —
all four are rebindable from the popup.

- `[` — set the loop's start point to the current playback position
- `]` — set the loop's end point to the current playback position
- `\` — arm/disarm the loop (same as clicking the button)
- `Enter` — refine: nudges your end point to the nearest spot (within
  about six tenths of a second either way) where the audio actually matches the
  motif at your start point, so the seam sounds closer to "that's just how
  the song goes" instead of an audible splice. It compares waveform shape,
  not raw distance, and explicitly skips over quiet gaps so it can't hide
  the seam in silence instead of a real repeat. It works by briefly muting
  and fading to black, silently scrubbing to each point, comparing a short
  captured audio snippet from each, then fading back in where you left off
  — about three seconds total. This is a coarse match, not sample-perfect
  phase alignment, so treat it as a nudge in the right direction rather
  than a guarantee - real repeated sections in a song (a second chorus, a
  repeated riff) are often not bit-identical, so it won't always find a
  perfect seam. It needs the same audio routing as the fade above, so it's
  subject to the same fallback: if that's unavailable, pressing `Enter`
  does nothing rather than risk anything odd.

## How it works, briefly

The loop mechanism is a `requestAnimationFrame` loop watching the video
element's `currentTime`; when it naturally crosses your end point during
forward playback, it jumps `currentTime` back to your start point — fading
out and back in first if the fade duration isn't set to 0, otherwise it's
an instant cut. No video is downloaded, re-encoded, or modified — this only
controls playback position and, when fading, opacity of the video already
loaded in the page.


The parts most likely to break on a future YouTube redesign: the button and
the two handles both depend on YouTube's internal CSS class names
(`.ytp-right-controls`, `.ytp-progress-bar-container`), which aren't a
published API. If that happens, the button/handles may stop appearing even
though the underlying loop logic in `content.js` is untouched — it's a
matter of updating those two selectors to whatever YouTube renamed them to.

## Permissions

Just `storage`, to remember your loop points per video and your fade/keybind
settings. No host permissions, no network requests, nothing leaves your
browser.