-- File tree manager. Replacement for the builtin one (netrw)
vim.pack.add({ {
  src = 'https://github.com/nvim-tree/nvim-tree.lua',
  version = 'v1.15.0'
} })

require("nvim-tree").setup()
