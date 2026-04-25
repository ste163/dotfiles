# Dotfiles 

## oh-my-zsh (.zshrc)

1. Install `oh-my-zsh`
2. Copy the contents of `.zshrc` and overwrite the values in the default `.zshrc`

## tmux 

Move the config file into:
`~/.tmux.conf`

### Mac

1. `brew install tmux`
2. Open the `.terminal` profile in `Terminal` 
3. `brew install btop` for system resource usage. Move the conf file to `~/.config/btop/btop.conf`


## neovim

> Config uses built-in package manager. Requires 0.12+

Move the `nvim` directory into:
`~/.config`

Download `neovim` directly from the repo. We want to ensure that once the setup is working, it stays solid for good until we want to specify an upgrade.

