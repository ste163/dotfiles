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

Install from https://pi.dev/

After running `install.sh` (and after `pi` is installed), manually run:

```sh
pi update --all
```

to install packages referenced in `settings.json` (package installs live under
`~/.pi/agent/npm` and `git`, which aren't synced across machines).

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
