# The Crossing at Side Cut

A first-person horror game set at Blue Grass Island in Side Cut Metropark,
Ohio. Cross the river stones at dusk, find the five effigies that unseal the
stone tower, descend to what waits at the bottom — and outrun it home.

Features: a full collect-open-descend-escape gameplay loop, lore notes
telling the story of the last people who crossed, a stuttering cryptid built
on a real animated model, treeline glimpses before the encounter, dynamic
sunset-to-night atmosphere with mist, fireflies, and stars, real music that
turns on you during the chase, synthesized wildlife/footsteps/heartbeat, a
lantern with fuel, stamina with exhaustion vignette, a compass HUD, escape
best-times, and an in-game update log.

**Play it in the browser** — built with [Three.js](https://threejs.org/) and
[Vite](https://vitejs.dev/).

## Development

```sh
npm install
npm run dev      # local dev server
npm run build    # production build -> dist/
```

Pushes to `main` deploy automatically to GitHub Pages.

## Project structure

| Path | Purpose |
| --- | --- |
| `src/main.js` | Bootstrap: scene, game loop, pointer lock |
| `src/retro.js` | PSX pipeline: 320x240 render target, vertex snapping, affine texture mapping |
| `src/world.js` | World built from the map data: river, crossing stones, island forest, footpath, beach, tower |
| `src/player.js` | First-person controller: walk, sprint, jump, stamina |
| `src/textures.js` | Procedural 64x64 canvas textures |
| `src/data/map.json` | Top-down layout of the Blue Grass Island region |
| `Images and JSON/` | Real-world reference photos and the original map data |

## Credits

- Music: "The Dread", "Five Armies" — Kevin MacLeod (incompetech.com),
  licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- Horse model: [three.js examples](https://github.com/mrdoob/three.js) (MIT)

## Roadmap

- [x] PSX-style renderer (low-res, vertex jitter, affine textures)
- [x] First-person controller with stamina
- [x] Sunset river, crossing stones, island forest, footpath, beach, tower exterior
- [x] Footstep audio per surface, wind/river ambience (all synthesized, `src/audio.js`)
- [x] The descent: tower doorway to the underground spiral and the chamber
- [x] Game manager: exploration -> encounter -> chase, dynamic fog/night transition
- [x] The Not-Deer: model, twitch animation, pursuit AI
