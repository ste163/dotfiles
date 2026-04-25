-- File tree manager. Replacement for the builtin one (netrw)
vim.pack.add({ {
  src = 'https://github.com/nvim-tree/nvim-tree.lua',
  version = 'v1.15.0'
} })

require("nvim-tree").setup({
  filters = {
    git_ignored = false -- Disable hiding .gitignored files/dirs
  },
  update_focused_file = {
    enable = true -- Have nvim-tree's selected file match the open buffer
  },
  view = {
    side = "right",
    adaptive_size = true
  }
})
