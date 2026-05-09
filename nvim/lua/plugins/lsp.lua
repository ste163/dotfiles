vim.pack.add({
	{
		src = "https://github.com/neovim/nvim-lspconfig",
		version = "v2.8.0",
	},
	{
		src = "https://github.com/mason-org/mason.nvim",
		version = "v2.2.1",
	},
	{
		src = "https://github.com/mason-org/mason-lspconfig.nvim",
		version = "v2.2.0",
	},
})

-- Package manger for LSPs
require("mason").setup({
	ui = {
		icons = {
			package_installed = "✓",
			package_pending = "➜",
			package_uninstalled = "✗",
		},
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
		"eslint",
		"pyright",
	},
})

-- Enable built-in LSP completion. Fires once per LSP client attach.
vim.api.nvim_create_autocmd("LspAttach", {
	group = vim.api.nvim_create_augroup("my.lsp", {}),
	callback = function(ev)
		local client = assert(vim.lsp.get_client_by_id(ev.data.client_id))
		if client:supports_method("textDocument/completion") then
			-- Trigger completion on every keypress.
			local chars = {}
			for i = 32, 126 do
				table.insert(chars, string.char(i))
			end
			client.server_capabilities.completionProvider.triggerCharacters = chars
			vim.lsp.completion.enable(true, client.id, ev.buf, { autotrigger = true })
		end
	end,
})

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
