# Dotfiles

## Setup (new machine)

Clone the repo and run the install script:

```sh
git clone git@github.com:ste163/nvim-setup.git ~/Github/dotfiles
cd ~/Github/dotfiles
bash ./install.sh
```

`install.sh` creates symlinks for all configs. Changes pulled via `git pull`
are live immediately. Edits to `~/.tmux.conf` etc. are edits to the repo — just `git add` and push.

### zsh

1. Install `oh-my-zsh`
2. Add the following line to `~/.zshrc`, **after** `export ZSH=...` but **before** `source $ZSH/oh-my-zsh.sh`:

   ```sh
   source ~/Github/dotfiles/.zshrc.shared
   ```

`.zshrc.shared` sets the theme and plugins that oh-my-zsh reads at startup. Machine-specific
paths and secrets stay in your local `~/.zshrc` below the `source $ZSH/oh-my-zsh.sh` line
and are never committed.

## font

Install the Nerd font from `fonts/`.

## ghostty

```sh
brew install ghostty
```

## tmux

```sh
brew install tmux
```

## Btop

```sh
brew install btop
```

## pi

Install from <https://pi.dev/>

After running `install.sh` (and after `pi` is installed), manually run:

```sh
pi update --all
```

to install packages referenced in `settings.json` (package installs live under
`~/.pi/agent/npm` and `git`, which aren't synced across machines).

### Skills

`.pi/skills/` is a whole-dir symlink (see `install.sh`), so every skill in the
repo deploys automatically. No install step, and no `install.sh` rerun when
you add one.

- **simple-english** — vendored from
  [AminBlg/SimpleEnglish](https://github.com/AminBlg/SimpleEnglish) (MIT, v1.3.0,
  pinned at commit `8e8a008a13e4`, 2026-08-21). It enforces ASD-STE100
  Simplified Technical English on technical prose. Mode is pragmatic; say
  "STE" for strict mode. `APPEND_SYSTEM.md` keeps it always on.

To update the skill: re-download the four files from `skills/simple-english/`
in the upstream repo, then update the pin above. pi-lens autofix may reformat
table padding on save — cosmetic only.

### MCP

The `codebase-memory-mcp` server is core to this setup. Ensure it's downloaded and able to run:
<https://deusdata.github.io/codebase-memory-mcp/>

Update the mcp server with `codebase-memory-mcp update`

### Extensions

`.pi/extensions/` is a real, tracked directory — not a symlink itself. It holds two
kinds of content side by side:

- **Package-managed state**, e.g. `pi-permission-system/` (installed via the `packages`
  entry in `settings.json`). Its `config.json` is tracked/shared on purpose (that's the
  point of this repo); its `logs/` are gitignored.
- **Our own hand-written extensions**, whose actual source lives in
  [`pi-extension-development/`](pi-extension-development/) — a standalone TypeScript
  project with its own `package.json`, `tsconfig.json`, linting, formatting, and tests.
  There is no build step: pi loads extensions via `jiti`, which runs `.ts` files
  directly at load time, so the exact files being typechecked/linted/tested are the
  exact same files pi loads — nothing is compiled or copied.

`install.sh` bridges the two: for every directory under
`pi-extension-development/extensions/`, it creates a matching symlink inside
`.pi/extensions/` (e.g. `.pi/extensions/plan-mode -> pi-extension-development/extensions/plan-mode`).
The existing whole-dir symlink (`.pi/extensions -> ~/.pi/agent/extensions`) then carries
both the package-managed state and our dev extensions through to pi automatically.

**Adding a new extension:** create it under `pi-extension-development/extensions/<name>/`
(see that directory's own README/AGENTS.md for the required structure and workflow), then
rerun `install.sh` once so its symlink gets created in `.pi/extensions/`. After that,
editing the extension's source is live immediately (same as everything else symlinked
by this repo) — only brand-new extension directories need `install.sh` rerun.

## neovim

> Setup using NVIM v0.12.2, using the built-in package manager and built-in tree-sitter

### Installing neovim

1. Download the `tree-sitter-cli` from `brew` on macOS or other package manager

#### Fresh macOS install

1. Download v0.12.2 from nvim github
2. Extract the archive:

    ```sh
    tar xzf nvim-macos-arm64.tar.gz
    ```

3. Clear the macOS quarantine flag (required or it will be blocked from running):

    ```sh
    xattr -cr nvim-macos-arm64
    ```

4. Move to `/opt/`:

    ```sh
    sudo mv nvim-macos-arm64 /opt/nvim
    ```

5. Reload your shell:

    ```sh
    source ~/.zshrc
    ```

6. Verify:

    ```sh
    nvim --version
    ```

### Removing a package

1. Remove the plugin spec from `vim.pack.add()` in the relevant plugin file under `nvim/lua/plugins/` — otherwise it will be reinstalled on next startup.
2. Inside Neovim, run:

   ```
   :lua vim.pack.del({'<plugin-name>'})
   ```

   The plugin name defaults to the repository name (e.g. `blink.cmp` for `Saghen/blink.cmp`).
3. Neovim opens a confirmation buffer — run `:write` to confirm deletion or `:quit` to cancel.
4. `nvim-pack-lock.json` is updated automatically after confirmation.

**Example — removing `blink.cmp`:**

```
:lua vim.pack.del({'blink.cmp'})
```

#### Reinstall / upgrade

Remove the old version:
    ```sh
    sudo rm -rf /opt/nvim
    ```

Follow fresh install steps
