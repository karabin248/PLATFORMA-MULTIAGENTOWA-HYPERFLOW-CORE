# PWA Icons

Place the following PNG files in this directory before deploying:

| File | Size | Purpose |
|---|---|---|
| `icon-192.png` | 192×192 px | Standard home screen icon |
| `icon-512.png` | 512×512 px | Splash screen / Play Store |
| `icon-maskable-512.png` | 512×512 px | Maskable icon (Android adaptive icon) — safe zone is centre 80% |

## Generating icons

If you have a source SVG (`icon.svg`):

```bash
# Using sharp-cli (npm i -g sharp-cli)
sharp -i icon.svg -o icon-192.png resize 192
sharp -i icon.svg -o icon-512.png resize 512
sharp -i icon.svg -o icon-maskable-512.png resize 512
```

Or use https://maskable.app to preview and export the maskable variant.

## Maskable icon guidelines

- The main logo should fit within the centre **80%** of the canvas
- Background fills the full 512×512 (use `#0f172a` to match theme_color)
- Android will clip to various shapes (circle, squircle, teardrop)
