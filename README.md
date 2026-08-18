# Splice Looper for YouTube

Loop just the part of a video you actually want, without leaving the YouTube
tab. A small button sits in YouTube's own player controls; click it to arm
a loop, then drag two points directly on the seek bar to mark where it
starts and ends.

## Install (unpacked, for personal use)

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
- The jump itself fades the video out and back in over about a tenth of a
  second rather than cutting instantly, to soften the jump-cut. The audio
  still cuts cleanly at that instant- crossfading the actual audio stream
  isn't something available to a content script.
- Your marked segment is remembered per-video (via `chrome.storage.local`),
  so reopening the same video later restores where you left the dots, and
  whether the loop was on.

### Keyboard shortcuts

With the player focused (not typing in a text box):

- `[` — set the loop's start point to the current playback position
- `]` — set the loop's end point to the current playback position
- `\` — arm/disarm the loop (same as clicking the button)

## How it works, briefly

The loop mechanism is a `requestAnimationFrame` loop watching the video
element's `currentTime`; when it naturally crosses your end point during
forward playback, it fades out, jumps `currentTime` back to your start
point, and fades back in. No video is downloaded, re-encoded, or modified —
this only controls playback position and opacity of the video already
loaded in the page.

If you manually scrub past the end point on purpose (skipping ahead), it
won't fight you — the loop only triggers on natural forward playback
crossing the boundary, not on a manual seek.

The parts most likely to break on a future YouTube redesign: the button and
the two handles both depend on YouTube's internal CSS class names
(`.ytp-right-controls`, `.ytp-progress-bar-container`), which aren't a
published API. If that happens, the button/handles may stop appearing even
though the underlying loop logic in `content.js` is untouched — it's a
matter of updating those two selectors to whatever YouTube renamed them to.

## Permissions

Just `storage`, to remember your loop points per video. No host permissions,
no network requests, nothing leaves your browser.
