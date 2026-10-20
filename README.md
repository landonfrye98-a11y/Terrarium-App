# Glasswild

A living terrarium for your phone, with a clock at its centre. Plant what you're working on as seeds. Tend them while you focus and they sprout. Finish them and they bloom into creatures. The look borrows from the alien ecology of *Scavengers Reign*: chalky creams, sun-faded ochres, coral and salmon flesh tones, dusty teals, mauve dusks and ink-violet nights.

## Getting it on your phone

**Android (recommended): install the web app.**
1. On your phone, open **https://landonfrye98-a11y.github.io/Terrarium-App/** in Chrome.
2. Tap ⋮ → **Install app** (or **Add to Home screen**).

It gets its own icon, runs fullscreen, works offline, and updates itself whenever this repo changes. Your terrarium lives on the phone.

**iPhone:** open the same link in Safari → Share → **Add to Home Screen**.

**Android APK (optional):** each push also builds `Glasswild.apk` under **Releases**. To make APK updates install over each other, add a signing key as repo secrets `ANDROID_KEYSTORE_BASE64` (a base64-encoded keystore with alias `glasswild`) and `ANDROID_KEYSTORE_PASSWORD`. Without these secrets, each build is signed with a throwaway key, and you have to uninstall the old APK before installing a new one.

## What lives here

| | Species | Arrives after | Notes |
|---|---|---|---|
| 🐚 | Scuttler | from the start | Detritivores. They tunnel through the soil cutaway, eat fallen fruit and husks, enrich the soil, and split when well fed. |
| 🦋 | Petalmoth | from the start | Pollinators with watching wing-eyes. They ripen bulbstalks, glow at night and rest on the clock ring. |
| 🎈 | Bellwisp | 1 task | Light-drinking bladders that burst into spores at the end of their lives. |
| 🐟 | Ribbonfin | 2 tasks | Live in the pond pocket and sometimes leap out of the water. |
| 🦒 | Stiltstrider | 4 tasks | Cup-headed grazers on stilt legs. They sleep folded up at night and lay speckled eggs. |
| 👁 | Mindbloom | 8 tasks | Hangs from the glass and pulses. Nearby creatures stop and stare. It glows brighter while you focus. |
| 🐋 | Gloamwhale | 12 tasks | A huge shape that sometimes drifts across the far sky. |

Plants follow the same rules. Fanferns, bulbstalks, lantern lilies and puffcaps grow from fertile soil, feed the animals, wither, and rot back into the ground. Tubeblooms appear after 6 finished tasks and coilspires after 10.

**Creatures evolve.** Every creature carries a genome: palette colours, size, and leg, wing, tendril and eye counts. Offspring inherit it with small drift and the occasional mutation, such as a six-legged strider, a third eye-stalk or a new glow. Generations are recorded in the field journal.

**Tasks become creatures.** Finishing a task hatches a creature at its pod. The task's words seed the creature's genome, so the same words always produce the same colours. The day's finished tasks stay as blooms until midnight and also orbit inside the clock as amber seeds. Overnight they compost into the soil.

**Time keeps passing.** The sky follows the real time of day: dawn, haze-teal day, gold afternoon, magenta dusk and a bioluminescent night. When you reopen the app, the simulation catches up on the hours you were away and tells you what happened.

## Battery

- Frames are paced with `setTimeout` → `requestAnimationFrame`, so the CPU sleeps between frames. There are three modes: **Saver** (12 fps at 1× resolution), **Balanced** (24 fps) and **Fluid** (60 fps).
- Rendering is split into tiers. The landscape is cached and repainted about once a minute. Plants and seed pods repaint at 4–10 fps and the clock face at 1–2 fps. Only creatures and particles update every frame.
- After 3 minutes without a touch the app "drowses" to a lower frame rate.
- Glows are pre-rendered sprites. No `shadowBlur` or filters run per frame.
- Everything stops when the app is hidden. The simulation is replayed in coarse steps instead of being animated.
- Ambient sound is off by default. When it's on, the audio context is suspended whenever the app is hidden.
- **Keep screen awake** is on by default, since the app is made for watching while you work. You can turn it off under **Glass**.

## Development

```sh
npm run serve          # http://localhost:8080 — no build step, plain ES modules in www/
```

Debug URL parameters: `?fresh` (ignore the save), `?hour=20` (force the sky), `?done=12` (pretend 12 tasks are finished), `?warp=60` (speed up time), `?perf=saver`, `?fps` (log frame rate).

The Android wrapper is [Capacitor](https://capacitorjs.com) (`android/`). CI (`.github/workflows/android.yml`) runs `cap sync` and `gradlew assembleRelease`, then publishes the release. `.github/workflows/pages.yml` deploys `www/` to GitHub Pages.

```
www/js/
  main.js      boot, frame loop, input, persistence, wake lock
  world.js     terrain, soil, populations, life ticks, offline catch-up
  fauna.js     the six creature species, eggs, the gloamwhale
  flora.js     plants
  tasks.js     tasks as seed pods / sprouts / blooms
  scenery.js   cached sky, planet, megaflora, hills, soil cutaway, pond, glass
  clock.js     the organic clock
  ui.js        sheets, journal (live-drawn portraits), settings, inspector
  audio.js     optional generative ambience (WebAudio, no samples)
  palette.js   colours and the 24-hour sky
```
