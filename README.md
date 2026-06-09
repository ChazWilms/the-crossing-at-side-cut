# The Crossing at Side Cut

A first-person horror game with a retro PS1/N64 aesthetic, set at Blue Grass
Island in Side Cut Metropark, Ohio. Cross the river stones at sunset, follow
the island path into the fog, find the stone tower on the far beach — and
survive what waits beneath it.

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

## Roadmap

- [x] PSX-style renderer (low-res, vertex jitter, affine textures)
- [x] First-person controller with stamina
- [x] Sunset river, crossing stones, island forest, footpath, beach, tower exterior
- [ ] Footstep audio per surface, wind ambience
- [ ] Tower interior and the spiral descent
- [ ] Game manager: exploration -> encounter -> chase, dynamic fog/night transition
- [ ] The Not-Deer: model, twitch animation, pursuit AI
