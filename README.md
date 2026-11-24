# Hyper

Internal product-render tool: import 3D models, set up materials, lights and camera, then path-trace a photoreal still.
Browser first, Windows desktop later.

## Prototype (`prototype/`)
Phase-1 test bench. Builds to one self-contained page.

```bash
cd prototype && npm install && npm run build   # -> dist/index.html (+ occt-import-js.wasm for STEP)
```

- **Prepare**: import (GLB/GLTF, OBJ+MTL, STL, PLY, FBX, 3MF, STEP/IGES), move/rotate/scale, materials (library, patterns, image wrap), lights (softbox / strip / disc, 360° + height, Kelvin), camera, scenarios.
- **Render**: progressive path tracer (three-mesh-bvh SAH BVH, WebGL2), tiled high-resolution export (1K to 8K) stitched in system RAM, Lightroom-style adjustments, tone-map profiles, `.cube` LUTs, saved scenes, batch ZIP.
- Lights are baked into the environment map so they appear in reflections and give soft physical shadows.
- Not yet: WebGPU compute path tracer, KTX2/BC7 textures, OIDN, GPU instancing, turntable video, undo.
