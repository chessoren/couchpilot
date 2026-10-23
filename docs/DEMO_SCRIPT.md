# Demo script and shooting checklist

## Reliable demo phrases (each tested 3 times in a row by `npm run test:e2e` and by the recorder)

| Demo | Exact phrase | Then |
| --- | --- | --- |
| 1 · The heart | `Resume my detective show where I left off, and turn it up.` | Watch: 4 steps, the TV drives, video starts at 23:12, volume 30 |
| 2 · Multimodal | `Put on something for the kids.` | Answer with the remote: **▼**, **▲**, **OK** (or say "the first one") |
| 3 · Routine | `Movie night.` | Press **Shift+T** a few times (or `couchPilot.advanceClock(110)` in the console) to show the 11 PM reminder |
| 4a · Payment | `Rent Dune Song.` | Say `No` (or press OK on the default "No, thanks") |
| 4b · Stop | `Find me a documentary about space, under an hour.` | Say `Stop` or press **Esc/Back** during step 2 |
| MCP | In http://localhost:8787/alexa type `Movie night, and remind me at 11.` | The TV tab drives itself |

Always start a take from `http://localhost:8787/?fresh` (resets memory, kids mode and rentals).

## Shooting checklist

1. `npm install && npm start` (Node 18+).
2. Open `http://localhost:8787/?fresh&showkeys` in Chrome, full screen (F11), 1920×1080. `showkeys` shows remote presses on screen.
3. For the Fire TV take: install `dist/couchpilot-fire-tv.apk` with `adb install -r`, open Couch Pilot from Your Apps & Channels, film the TV (or capture with `adb shell screenrecord`). Use ☰ Menu to talk, Back to stop.
4. For the MCP take: open `/alexa` in a second window next to the TV window.
5. Record each demo separately and keep the best take. Don't attempt a single continuous shot.
6. Voice-over recorded separately. No music, no third-party brands on screen.
7. Upload to YouTube or Vimeo as **Public**, check the link in a private window.

The submitted video was produced by `tests`-style automation: Playwright records the real app (no mock-ups), synthesized voices are aligned to the app's own event log, and captions are burned in.
