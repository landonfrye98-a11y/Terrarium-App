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
| 🪤 | Snaplure, Dewveil | 15 tasks | Carnivorous plants. A glowing trap that lures petalmoths, and a sticky curtain on the ceiling that catches bellwisps. |
| 🦂 | Hookjaw | 20 tasks | A ground stalker. It picks off the weakest scuttlers and raids strider eggs. Burrowed scuttlers are safe from it. |
| 🗡 | Lancewing, Mire-eel | 25 tasks | An aerial diver that hunts petalmoths, and a pond ambusher that eats ribbonfin roe and fry. |

## A self-sufficient ecosystem

Nothing in the glass is created from nothing.
- **A fixed pool of nutrient** cycles from soil to plants, to grazers, to predators, to carcasses, to scuttlers, and back to the soil. Finished tasks are the only outside input: your work feeds the glass.
- **Breeding depends on food.** A creature needs enough nutrient in its body to build a child, so a crowded glass starves itself back down and a sparse one recovers. Hard limits remain only as a drawing budget for the phone.
- **Predators keep populations in check.** They need time to digest after a kill. They stop hunting when their prey gets scarce, and they prefer the young, the old and the sick. Their numbers rise and fall with their prey's.
- **The gloomcap fungus** spreads where creatures crowd together. Its victims stagger, die, and sprout pale mushrooms that seed more of it.
- **Seed banks** hold dormant eggs and spores in the soil. They bring a species back when it dwindles. Outsiders only arrive if a species has been gone for days.
- **Traits matter.** Speed costs energy. Glowing helps a creature breed but shows it to predators at night. Colours that match the background help it hide. Over days, lineages adapt.
- **Temperament is inherited.** Each creature carries four behaviour genes, and each one trades one way of surviving for another:
  - *Shy ↔ Bold.* Bold creatures forage further and burrow less, but are easier to catch.
  - *Loner ↔ Social.* Social creatures herd with their kin, which dilutes predation but spreads fungus. Social predators hunt as a pack instead of getting in each other's way.
  - *Dreamy ↔ Watchful.* Watchful creatures slip predators and shake off the mindbloom's trance, but burn more energy.
  - *Long-lived ↔ Prolific.* Prolific creatures breed readily and die younger.

  Offspring drift a little from their parents, and now and then a temperament leaps. Selection does the rest: in a glass full of hunters petalmoths turn watchful, and where fungus spreads scuttlers turn into loners.

`npm test` runs `tools/tasks.test.mjs` (due-date parsing, weeds, snoozing, steps, old saves) and then `tools/sim.mjs`, which plays seeded terrariums forward for days and checks the invariants:
- nutrient is conserved;
- there are no NaNs;
- the census matches a recount;
- populations stay within the performance ceilings;
- extinctions get rescued;
- a 4-day catch-up stays fast;
- every living creature has a family record, and the records stay bounded.

`node tools/sim.mjs --blight=0.6` plays a feral weed over a third of the glass, to see what neglect costs. `node tools/sim.mjs --traits` also prints where each species' temperament drifted to.

Plants follow the same rules. Fanferns, bulbstalks, lantern lilies and puffcaps grow from fertile soil, feed the animals, wither, and rot back into the ground. Tubeblooms appear after 6 finished tasks and coilspires after 10.

**Creatures evolve.** Every creature carries a genome: palette colours, size, and leg, wing, tendril and eye counts. Offspring inherit it with small drift and the occasional mutation, such as a six-legged strider, a third eye-stalk or a new glow. The field journal's **Family** tab draws every line as a tree: founders, children, grandchildren, who is still alive, and how the rest died, with each creature's temperament. Tap *Family tree* on any creature to jump to its place in it.

**Tasks become creatures.** Finishing a task hatches a creature at its pod. The task's words seed the creature's genome, so the same words always produce the same colours. The day's finished tasks stay as blooms until midnight and also orbit inside the clock as amber seeds. Overnight they compost into the soil.

## Tasks: due dates, steps, and weeds

- **Due dates in plain words.** End a task with when it's due and the date comes off the title: `collect trash sunday`, `call vet tomorrow 3pm`, `taxes by oct 24`, `rent 11/1`, `review in 3 days`, `clean garage this weekend`. Titles like "Sunday school prep" are left alone. You can also set or change a date with the Today / Tomorrow / Weekend chips or the date and time pickers.
- **Steps.** Put steps after a colon (`Clean the house sun: make to do list, collect trash, vacuum`), paste a list (the first line becomes the task, every other line a step), or add them one by one. A task with steps grows a stalk with a bud for each step. Each finished step opens its bud, and the last one blooms the whole task into a creature, a bigger one for a bigger job.
- **A list you can scan.** The Tasks sheet groups everything into Growing now, Overdue, Today, Upcoming and Someday, with counts. Tap a task to unfold its steps, due date, focus target, snooze, rename and compost. When more than six tasks are planted, only the urgent ones (active, overdue, due today) keep a label in the glass.
- **Work from the glass.** Tap a seed pod or its weeds and a card opens right there. From it you can tick steps, add one, change the date, start focus, snooze, or finish.
- **Neglect grows weeds, gently at first:**
  1. *Day one overdue:* thorny shoots push out of the pod. Only ugly.
  2. *Days 1–3:* the weed spreads and sours its patch. Plants there start dying and nothing new sprouts.
  3. *Days 3–7:* it goes feral. Brambles reach the neighbouring patches and their thorns wear down creatures that live among them.
  4. *A week or more:* blight. Its spores give nearby creatures the gloomcap fungus.

  Tasks with no date get a week from when they were last touched (started, edited or a step ticked), wilting for the last few days of it. Finishing a task kills its weed at once. Snoozing makes the weed die back over a few hours. *Pull the weed* drops the task altogether. The Tasks button turns red with the number of overdue tasks, and so does the app icon on Android when Glasswild is installed.


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

**Focus timer:**
- Each task has a target. Use − and + to step in 5 minutes, or type any number of minutes.
- The sprout reaches full bloom exactly at the target, and the app chimes and vibrates.
- While you work, a cloud drifts across the sky with the task and minutes left written faintly on it.
- A small comet streaks by every 5 minutes, and a big amber one when you reach the target.
- **+5** on the focus bar stretches the session.

**Commanding predators:** select a hookjaw, lancewing, mire-eel, snaplure or dewveil and press **Send to hunt**. You can only do this once every 20 minutes. Predators still won't take the last few of a species, so you can't empty the glass. Every kill plays a short animation: a strike flash, claw marks, the prey pulled into the predator's mouth, and fragments falling.

**Music (optional):** a cozy lo-fi score made for working to.
- Warm 7th chords in a major key: brighter in the morning, mellower at night.
- A relaxed groove: soft kick, wooden ticks, round bass and a swung electric-piano arpeggio.
- The creatures decorate the tune in key, each in its own voice, and get busier when the glass is busy.
- While you focus, the groove keeps going but the decorations thin out.

It uses one fixed pool of synth voices and suspends itself when hidden or idle.

**Creature calls:** tap any creature and it answers in its own instrument, with a short phrase unique to that individual. This works even with the ambient music off, and it can be turned off under Glass.

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
