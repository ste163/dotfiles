#!/usr/bin/env bash
set -e

DOTFILES="$(cd "$(dirname "$0")" && pwd)"

echo "Dotfiles: $DOTFILES"
echo ""

# .tmux.conf
ln -sf "$DOTFILES/.tmux.conf" "$HOME/.tmux.conf"
echo "Linked: ~/.tmux.conf"

# nvim — remove only if it's already a symlink, otherwise error
mkdir -p "$HOME/.config"
if [ -L "$HOME/.config/nvim" ]; then
  rm "$HOME/.config/nvim"
elif [ -e "$HOME/.config/nvim" ]; then
  echo "Error: ~/.config/nvim already exists and is not a symlink. Back it up and remove it first."
  exit 1
fi
ln -sf "$DOTFILES/nvim" "$HOME/.config/nvim"
echo "Linked: ~/.config/nvim"

# btop
mkdir -p "$HOME/.config/btop"
ln -sf "$DOTFILES/btop.conf" "$HOME/.config/btop/btop.conf"
echo "Linked: ~/.config/btop/btop.conf"

echo ""
echo "Action required: add the following line to your ~/.zshrc (if not already present)."
echo "It must come AFTER 'export ZSH=...' but BEFORE 'source \$ZSH/oh-my-zsh.sh':"
echo ""
echo "  source $DOTFILES/.zshrc.shared"
echo ""
echo "Manual steps:"
echo "  - Install font from $DOTFILES/fonts/"
echo "  - Open $DOTFILES/mac-profile.terminal in Terminal.app to import the profile"

# --- Verification ---
echo ""
echo "Verifying symlinks..."
echo ""

PASS=0
FAIL=0

check_link() {
  local link="$1"
  local expected_target="$2"
  local actual_target
  actual_target="$(readlink "$link" 2>/dev/null || echo "")"
  if [ "$actual_target" = "$expected_target" ]; then
    echo "  ✓  $link -> $actual_target"
    PASS=$((PASS + 1))
  else
    echo "  ✗  $link"
    if [ -z "$actual_target" ]; then
      echo "     (not a symlink or does not exist)"
    else
      echo "     points to: $actual_target"
      echo "     expected:  $expected_target"
    fi
    FAIL=$((FAIL + 1))
  fi
}

check_link "$HOME/.tmux.conf"             "$DOTFILES/.tmux.conf"
check_link "$HOME/.config/nvim"           "$DOTFILES/nvim"
check_link "$HOME/.config/btop/btop.conf" "$DOTFILES/btop.conf"

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "All $PASS symlinks OK."
else
  echo "$PASS passed, $FAIL failed. Review the errors above."
  exit 1
fi
