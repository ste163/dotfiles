vim.pack.add({
	{
		src = "https://github.com/neovim/nvim-lspconfig",
		version = "4d363f93c3581b9212a24f7a830d7590b3f050af", -- v2.12.0
	},
	{
		src = "https://github.com/mason-org/mason.nvim",
		version = "2a6940af80375532e5e9e7c1f2fc6319a1b7a69d", -- v2.3.1
	},
	{
		src = "https://github.com/mason-org/mason-lspconfig.nvim",
		version = "a5671269a1ddfa7790cdf97c14e600e269da550f", -- v2.3.0
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

-- lua_ls defaults know vanilla Lua only, so every config file gets
-- `undefined global: vim` and no vim.* types. Point it at Neovim's runtime:
-- real API types from VIMRUNTIME, `vim` as a known global, LuaJIT as the
-- runtime, and no third-party noise. Canonical block from :h lspconfig.
-- Must run BEFORE mason-lspconfig's automatic_enable so the override is in
-- place when the server gets enabled (see :h lspconfig-nvim-0.11).
vim.lsp.config("lua_ls", {
	settings = {
		Lua = {
			runtime = { version = "LuaJIT" },
			diagnostics = { globals = { "vim" } },
			workspace = {
				library = { vim.env.VIMRUNTIME },
				checkThirdParty = false,
			},
			telemetry = { enable = false },
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
		"jsonls",
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
