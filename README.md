# pi-pocket-stable-fast-3d

A Pi Pocket drop-in that converts one conversation-scoped image into a textured 3D GLB
through a self-hosted [Stable Fast 3D](https://github.com/nikau-herewini/stable-fast-3d)
API. It mirrors the `pi-pocket-stable-diffusion` extension pattern.

## Tools

- `sf3d_generate`: converts one PNG/JPEG (at most 10,000,000 bytes and
  16,000,000 pixels) into a GLB saved under the extension's outputs directory.
  One call runs at a time across conversations. Unknown submissions are never
  retried automatically.

### 3D preview

On Pi Pocket builds with model preview support, new successful results include
**View in 3D**. It opens in the chat on desktop and fills the screen on phones.
Rotate, zoom, pan, reset the camera, or download the original GLB. Anyone who
can read the conversation can reopen its preview; there is no public link.

Older builds and outputs saved before this feature still return the original
GLB path for use with the artifact tool.

### Image sources

Supply an absolute local path to one of:

- An upload in the current conversation.
- An unchanged `sd_generate` output recorded in this conversation while both
  extensions are enabled. A hook records the output path and SHA256 from the
  successful tool result, including nested calls from codemode. Merely sharing
  Stable Diffusion's output directory does not grant access.
- A program-generated, resized, or compressed image under
  `<workspace>/.sf3d-inputs/<conversationId>/`. The `sf3d_inputs` prompt section
  gives Pi the exact folder. Programs must create it before saving files there.
  This folder requires a local workspace and must not be a symlink.

Older SD outputs have no recorded ownership. Copy them into the processed-image
folder to use them. Save edited SD outputs there too, rather than overwriting
recorded originals. Do not commit these working images to source control.

All sources have the same byte, pixel, and PNG/JPEG header checks. These checks
are not full image decoding; the backend can still reject corrupt images.
Validation errors identify the failed check and suggest a correction. No model
request is made when local validation fails.

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
