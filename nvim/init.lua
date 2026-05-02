vim.g.loaded_netrw = 1 -- turn netrw off and only use nvimtree
vim.g.loaded_netrwPlugin = 1

-- Optional: If you see progress bars as garbage text, try forcing the terminal type
vim.env.TERM = "xterm-256color"
require("config.options")
require("config.keymap")

require("plugins.telescope")
require("plugins.treesitter")
require("plugins.lsp")
require("plugins.conform")
require("plugins.nvim-tree")
require("plugins.fugitive")
require("plugins.diffview")
require("plugins.gitsigns")
require("plugins.mini-animate")

require("plugins.lualine")
require("plugins.rose-pine") -- may also need to be low to ensure theme is applied properly
require("plugins.which-key") -- should be last to load all keybinds

local fugitive_group = vim.api.nvim_create_augroup("FugitiveTerminalFix", { clear = true })

-- Use a neovim terminal for commit and push commands
vim.api.nvim_create_autocmd("FileType", {
	group = fugitive_group,
	pattern = "fugitive",
	callback = function()
		-- Open a real terminal for Committing
		vim.keymap.set("n", "cc", ":term git commit -v<CR>", { buffer = true, silent = true })
	end,
})

-- Handle terminal behavior (Scrolling & Auto-closing)
vim.api.nvim_create_autocmd("TermOpen", {
	group = fugitive_group,
	callback = function()
		vim.cmd("startinsert") -- Forces auto-scroll to the bottom
		vim.opt_local.number = false
		vim.opt_local.relativenumber = false
	end,
})

-- Automatically close the terminal window if the command finishes successfully and re-opens fugitive
vim.api.nvim_create_autocmd("TermClose", {
	group = fugitive_group,
	callback = function()
		if vim.v.event.status == 0 then
			vim.api.nvim_buf_delete(0, { force = true })
		end
	end,
})
