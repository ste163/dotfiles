#!/usr/bin/env bash
set -e

DOTFILES="$(cd "$(dirname "$0")" && pwd)"

# --- Config table (source, destination, type: file|dir) ---
SRCS=(
  "$DOTFILES/.tmux.conf"
  "$DOTFILES/btop.conf"
  "$DOTFILES/nvim"
  "$DOTFILES/ghostty"
)
DSTS=(
  "$HOME/.tmux.conf"
  "$HOME/.config/btop/btop.conf"
  "$HOME/.config/nvim"
  "$HOME/.config/ghostty"
)
TYPES=(
  "file"
  "file"
  "dir"
  "dir"
)

link_entry() {
  local src="$1" dst="$2" type="$3"
  mkdir -p "$(dirname "$dst")"
  if [ "$type" = "dir" ]; then
    if [ -L "$dst" ]; then
      rm "$dst"
    elif [ -e "$dst" ]; then
      echo "Error: $dst already exists and is not a symlink. Back it up and remove it first."
      exit 1
    fi
  fi
  ln -sf "$src" "$dst"
  echo "Linked: $dst"
}

echo "Dotfiles: $DOTFILES"
echo ""

for i in "${!SRCS[@]}"; do
  link_entry "${SRCS[$i]}" "${DSTS[$i]}" "${TYPES[$i]}"
done

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

for i in "${!DSTS[@]}"; do
  check_link "${DSTS[$i]}" "${SRCS[$i]}"
done

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "All $PASS symlinks OK."
else
  echo "$PASS passed, $FAIL failed. Review the errors above."
  exit 1
fi
