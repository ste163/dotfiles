-- Auto formatter
vim.pack.add({ {
  src = 'https://github.com/stevearc/conform.nvim',
  version = 'v9.1.0'
} })

require("conform").setup({
  formatters_by_ft = {
    lua = { "stylua" },
    javascript = { "prettier" },
  },
  format_on_save = {
    timeout_ms = 500,
    lsp_format = "fallback",
  },
})
