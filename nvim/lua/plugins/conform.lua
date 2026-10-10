-- Auto formatter
vim.pack.add({ {
	src = "https://github.com/stevearc/conform.nvim",
	version = "3543d000dafbc41cc7761d860cfdb24e82154f75", -- v9.1.0
} })

require("conform").setup({
	formatters_by_ft = {
		lua = { "stylua" },
		javascript = { "prettier" },
		json = { "prettier" },
		python = { "ruff_format" },
	},
	format_on_save = {
		timeout_ms = 500,
		lsp_format = "fallback",
	},
})
