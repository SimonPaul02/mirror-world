# Models

`npm run models` downloads the sample glTF vehicles here (they are gitignored —
re-run the command after a fresh clone).

To add your own aircraft permanently, drop a `.glb` in this folder and add an
entry to `MODELS` in `src/models.ts`. For a one-off, just drag the file onto the
running globe — no code change needed.

**Nose direction:** Cesium maps a glTF's `+Z` axis onto its local `+X`, which at
heading 0 points east. Models authored nose-along-`+Z` (all the Cesium samples)
therefore use `noseOffset: -Math.PI / 2`. If your model flies sideways, use the
**Nose offset** slider to find the correct value, then bake it into its entry.
