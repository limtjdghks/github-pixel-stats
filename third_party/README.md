# Third-party notices

The project's own source code is licensed under the MIT License in [`../LICENSE`](../LICENSE). That license does not cover the third-party materials below, which keep their original licenses.

| Material | Files in this repository | Where it ends up | License |
| --- | --- | --- | --- |
| [NeoDunggeunmo Pro](https://github.com/neodgm/neodgm-pro-webfont) typeface, webfont-kit commit `1751c2981808869750c7df391c1d2b486e978f12` | `assets/fonts/NeoDunggeunmoPro.woff2` | Embedded as a base64 `@font-face` in every generated SVG card | SIL Open Font License 1.1 with Reserved Font Name "NeoDunggeunmo Pro" — [`NEODGM-PRO-LICENSE.txt`](./NEODGM-PRO-LICENSE.txt) |
| [GitHub Linguist](https://github.com/github-linguist/linguist) 9.7.0 language metadata | `data/languages.yml` | Language names, file extensions and colors used to classify commits and color the language card | MIT License, Copyright (c) 2017 GitHub, Inc. — [`LICENSE-linguist`](./LICENSE-linguist) |

## Redistribution notes

- Keep both license files next to the materials when you copy or fork this repository.
- The font may be bundled, embedded and redistributed with the cards, but it must not be sold by itself. A modified version of the font must not use the Reserved Font Name.
- Before registering a new mascot preset in `src/render/mascot-registry.ts`, record its author, source and license, and the basis for using it in the hosted service, in this file.
