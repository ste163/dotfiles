# Dotfiles 

## font
Install the Nerd font.

## oh-my-zsh (.zshrc)

1. Install `oh-my-zsh`
2. Copy the contents of `.zshrc` and overwrite the values in the default `.zshrc`

## tmux 

Move the config file into: `~/.tmux.conf`

### Mac

1. `brew install tmux`
2. Open the `.terminal` profile in `Terminal`

#### Btop (Mac specific)

1. `brew install btop` for system resource usage.
2. Move the conf file to `~/.config/btop/btop.conf`

## neovim

> Setup using NVIM v0.12.2, using the built-in package manager. 

Move the `nvim` directory into `~/.config`:

```sh
mv nvim ~/.config/nvim
```

### Removing neovim

1. Delete the install directory:
    ```sh
    sudo rm -rf /opt/nvim
    ```

> This does not remove your config at `~/.config/nvim`.

### Installing neovim

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

#### Reinstall / upgrade (PATH already configured)

1. Remove the old version:
    ```sh
    sudo rm -rf /opt/nvim
    ```
2. Download `nvim-macos-arm64.tar.gz` from the [neovim releases page](https://github.com/neovim/neovim/releases)
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

