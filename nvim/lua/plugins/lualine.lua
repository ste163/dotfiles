-- Status line (ie the one on the bottom)
vim.pack.add({ {
  src = 'https://github.com/nvim-lualine/lualine.nvim',
  version = 'master'
} })

require('lualine').setup()
