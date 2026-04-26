vim.pack.add({
  {
    src = 'https://github.com/Saghen/blink.cmp',
    version = 'v1.10.2'
  },
  {
    src = 'https://github.com/neovim/nvim-lspconfig',
    version = 'v2.8.0',
  },
  {
    src = 'https://github.com/mason-org/mason.nvim',
    version = 'v2.2.1'
  },
  {
    src = 'https://github.com/mason-org/mason-lspconfig.nvim',
    version = 'v2.2.0'
  }
})

-- Package manger for LSPs
require("mason").setup({
  ui = {
    icons = {
      package_installed = "✓",
      package_pending = "➜",
      package_uninstalled = "✗"
    }
  },
})

-- Auto install and enable lsps
require("mason-lspconfig").setup({
  automatic_enable = {
    "ts_ls",
    "html",
    "cssls",
    "tailwindcss",
    "lua_ls",
    "eslint"
  }
})

-- Auto completion
require('blink.cmp').setup()

-- Setup icons
local severity = vim.diagnostic.severity

vim.diagnostic.config({
  signs = {
    text = {
      [severity.ERROR] = " ",
      [severity.WARN] = " ",
      [severity.HINT] = "󰠠 ",
      [severity.INFO] = " ",
    },
  },
})
