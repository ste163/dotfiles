-- Shows helper menu for what shortcuts are available
vim.pack.add({
  { src = 'https://github.com/nvim-tree/nvim-web-devicons',
    version = "58447c1fca354bbf184425e4a8d01deecbd6f3c4" }, -- master
  {
    src = "https://github.com/folke/which-key.nvim",
    version = "fcbf4eea17cb299c02557d576f0d568878e354a4", -- v3.17.0
  }
})

require("which-key").setup({
  win = {
    border = "rounded",
  },
})
