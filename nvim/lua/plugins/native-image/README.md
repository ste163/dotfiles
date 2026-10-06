# native-image

Native image rendering in Neovim nightly (0.13-dev) on top of the experimental
`vim.ui.img` API, working through tmux + Ghostty. Opens png/jpg/jpeg/gif/webp/
svg/pdf files directly as rendered images.

No third-party image plugins: the kitty graphics protocol sequences are
transmitted by this plugin itself.

## Requirements

- Neovim 0.13-dev nightly with `vim.ui.img`
- Ghostty (or any terminal speaking the kitty graphics protocol)
- tmux >= 3.4 with `set -gq allow-passthrough all` in `~/.tmux.conf`
  (`all`, not `on` — `on` silently drops passthrough from invisible panes)
- ImageMagick for jpg/gif/webp/svg conversion. svg also tries rsvg-convert.
  pdf uses sips on macOS, else pdftoppm, else magick+ghostscript.

## Architecture

| File | Role |
| --- | --- |
| `init.lua` | Loader — backend first, then viewer |
| `backend.lua` | Replaces `vim.ui.img` with a tmux-passthrough-aware implementation |
| `convert.lua` | Converts image formats to PNG bytes; in-memory session cache only |
| `viewer.lua` | Opens image files as rendered buffers via the public `vim.ui.img` API |
| `../../vim/ui/img/health.lua` | Healthcheck for `:checkhealth vim.ui.img` |

The healthcheck is shipped because some 0.13-dev nightlies predate core's, and
it deliberately shadows core's version (which would warn that tmux "may not
display correctly" — wrong for this setup, which wraps passthrough itself).

## Usage

- `:e path/to/image.png` (or open via nvim-tree) — renders centered in the window
- `q` — closes the image buffer
- `:NativeImageClear` — clears all placements and forgets image buffers
- `:checkhealth vim.ui.img` — terminal capability report

## Future state

The API is EXPERIMENTAL (nightly-only until 0.13, semantics not finalized).
The pieces have different lifetimes:

| Piece | Dies when |
| --- | --- |
| `backend.lua` (tmux passthrough wrapper) | Core handles passthrough itself (upstream floated `nvim_ui_send` as the home). Delete this file and its require in `init.lua`; the viewer keeps working against core's backend. |
| `health.lua` shadowing | Core's healthcheck becomes tmux-accurate. Delete together with the backend. |
| `viewer.lua` | Never, from any known plan — it becomes a plain consumer of the API once core supports tmux natively. |
| Whole plugin | Only if core ships its own image-file viewer — no such plan; core's goal is the API itself. |

Risk to watch: API churn before 0.13 stable. `backend.lua` mirrors core's
`runtime/lua/vim/ui/img/_kitty.lua` sequence construction and must track any
shifts.

## Limitations (v1)

- One image at a time
- Animated gif: first frame only
- Multi-page pdf: page 1 only
- No inline markdown images
- macOS only: sips-rendered PDFs have transparent backgrounds (black text on
  the terminal's dark background). Other platforms paint white. Fix lives in
  `convert.lua` `pdf_to_png` — composite onto white after sips (~4 lines).
- First open of an image in a session pays conversion (~100-500ms); later
  opens hit the in-memory cache. Nothing is written to disk.

## Invariants

Preserve these when editing:

- Lowercase-only BufReadCmd patterns: macOS `fileignorecase` makes `*.png` +
  `*.PNG` both match each event, firing setup twice and orphaning a placement.
- Delete-all (`del(math.huge)` = `d=A`) + fresh retransmit on every render
  transition. Ghostty window resizes orphan placements from image-id
  addressing, so per-id deletes can no-op.
- Per-id delete uses uppercase `d=I` (frees image data). Lowercase `d=i`
  accumulates images in the terminal across resize cycles.
- tmux poll targets `$TMUX_PANE` explicitly (`-t`); without it the query is
  tautological. Do not replace with focus events: `t_fe`/`t_fd` were removed
  in 0.13.
- `q=2` on all sequences (suppress responses — the query/response round-trip
  cannot survive passthrough).

## Maintenance

When a future-state piece expires or a limitation is lifted, update this file:
remove the corresponding row and record the change, so the README always
describes the current system.
