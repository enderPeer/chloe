# Asset Attributions

The 3D models and the HDRI **in the table below** are from [Poly Haven](https://polyhaven.com), licensed
[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) (public domain —
no attribution required; credited here anyway). Downloaded 2026-08-24 as the glTF
1k-texture variants (HDRI at 1k .hdr).

| Canonical id | Asset | Author(s) | Source | License |
|---|---|---|---|---|
| `sofa` | Sofa 01 | Kirill Sannikov | https://polyhaven.com/a/Sofa_01 | CC0 1.0 |
| `tv` | Television 01 (vintage tube TV) | Gabriel Radić | https://polyhaven.com/a/Television_01 | CC0 1.0 |
| `lamp` | Desk Lamp Arm 01 | Kuutti Siitonen (modeling & texturing), Yann Kervran (rigging) | https://polyhaven.com/a/desk_lamp_arm_01 | CC0 1.0 |
| `vanity` | Classic Console 01 | Kirill Sannikov | https://polyhaven.com/a/ClassicConsole_01 | CC0 1.0 |
| `chair` | Painted Wooden Chair 01 | Kuutti Siitonen | https://polyhaven.com/a/painted_wooden_chair_01 | CC0 1.0 |
| `clutter1` | Cassette Player | Oday Abuzaeed | https://polyhaven.com/a/cassette_player | CC0 1.0 |
| `clutter2` | Wine Bottles 01 | Rico Cilliers (modeling), Jurita Burger (graphic design) | https://polyhaven.com/a/wine_bottles_01 | CC0 1.0 |
| `hdri` | Creepy Bathroom (dark abandoned interior) | Greg Zaal | https://polyhaven.com/a/creepy_bathroom | CC0 1.0 |

Local paths: models under `game/assets/models/<canonical id>/` (entry `.gltf` + `.bin` +
`textures/*` at their original relative paths), HDRI at `game/assets/hdri/creepy_bathroom_1k.hdr`.
Manifest: `tools/model-manifest.json`. Total on-disk size: ~11.1 MB.

## User-supplied source archives

Not everything in `game/assets/3d/` came from Poly Haven. These were supplied by the
project owner as source archives (FBX/OBJ + loose PBR maps) and converted here with
headless Blender — relink the textures the source never wired, downscale to 1k, Draco,
export GLB. Provenance is recorded as given; where an archive carried no licence file,
that is stated rather than guessed.

| Asset | Local path | Source as supplied | Licence | Converted by |
|---|---|---|---|---|
| 9mm pistol | `game/assets/3d/gun9mm.glb` | User-supplied `9-mm.zip` (§29): `0ae7c8526de44d0ab63e6b5d21341fd2.fbx` + a 2k `GunGS_*` PBR set (albedo / NormalGL / roughness / metallic / AO / emissive), authored 2024-09-05 | **Not stated in the archive.** Supplied by the project owner for use in CHLOE; no licence file, author or marketplace listing shipped with it. If this ever needs redistributing on its own terms, ask the owner for the original listing. | `tools/convert-gun9mm.js` |

The archive also contained a backdrop plane (`Plane001` + `Plane_Diffuse`) and a `Sky001`
empty — beauty-shot furniture, not the pistol. Both are dropped by the converter, which is
why `gun9mm.glb` is 0.56 MB rather than carrying a 5 MB backdrop texture it never draws.
