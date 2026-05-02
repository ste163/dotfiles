# Dotfiles

## Setup (new machine)

Clone the repo and run the install script:

```sh
git clone git@github.com:ste163/nvim-setup.git ~/Github/dotfiles
cd ~/Github/dotfiles
bash ./install.sh
```

`install.sh` creates symlinks for tmux, nvim, and btop configs. Changes pulled via `git pull`
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

## tmux

```sh
brew install tmux
```

Open `mac-profile.terminal` in Terminal.app to import the color profile.

### Btop

```sh
brew install btop
```

The config is symlinked automatically by `install.sh`.

## neovim

> Setup using NVIM v0.12.2, using the built-in package manager and built-in tree-sitter

The `nvim/` directory is symlinked automatically by `install.sh`.

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
5. Add nvim to your PATH in `~/.zshrc`:
    ```sh
    export PATH="$PATH:/opt/nvim/bin"
    ```
6. Reload your shell:
    ```sh
    source ~/.zshrc
    ```
7. Verify:
    ```sh
    nvim --version
    ```

#### Reinstall / upgrade

1. Remove the old version:
    ```sh
    sudo rm -rf /opt/nvim
    ```
2. Download nvim from its repo 
3. Extract the archive:
    ```sh
    tar xzf nvim-macos-arm64.tar.gz
    ```
4. Clear the macOS quarantine flag:
    ```sh
    xattr -cr nvim-macos-arm64
    ```
5. Move to `/opt/`:
    ```sh
    sudo mv nvim-macos-arm64 /opt/nvim
    ```
6. Verify:
    ```sh
    nvim --version
    ```

