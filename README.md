# pi-pocket-stable-fast-3d

A Pi Pocket drop-in that converts one uploaded image into a textured 3D GLB
through a self-hosted [Stable Fast 3D](https://github.com/nikau-herewini/stable-fast-3d)
API. It mirrors the `pi-pocket-stable-diffusion` extension pattern.

## Tools

- `sf3d_generate`: converts one current-conversation upload (PNG/JPEG, at most
  10 MB and 16 million pixels) into a GLB saved under the extension's outputs
  directory. One call runs at a time across conversations. Unknown submissions
  are never retried automatically.

## Owner settings

- Service URL (default `http://stable-fast-3d:8000`).
- Generation timeout in minutes (1–120, default 30).

The module adds an owner-only settings sheet and owner commands `/sf3d-status`,
`/sf3d-recover`, and `/sf3d-reset`. It has no public routes and no telemetry.

## Deployment

Drop the runtime files into Pi Pocket's `extensions` directory, then enable the
module. The service must be reachable from the Pi Pocket server. The backend
image and its deployment guide live at
<https://github.com/nikau-herewini/stable-fast-3d>.

## Development

```sh
npm ci
npm test
npm run test:ui   # needs Chrome; set BROWSER_BIN if not at /usr/bin/google-chrome
```

See `test/` for the unit and settings-sheet tests.
