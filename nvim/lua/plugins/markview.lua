-- Markdown preview tool
vim.pack.add({ {
	src = "https://github.com/OXY2DEV/markview.nvim",
	version = "v28.2.0",
} })

require("markview").setup({
	preview = { icon_provider = "devicons" },
})
