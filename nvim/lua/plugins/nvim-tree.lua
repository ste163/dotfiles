-- File tree manager. Replacement for the builtin one (netrw)
vim.pack.add({ {
	src = "https://github.com/nvim-tree/nvim-tree.lua",
	version = "v1.17.0",
} })

local function on_attach(bufnr)
	local api = require("nvim-tree.api")

	-- 1. Load default mappings so <CR>, <C-v>, etc. still work
	api.config.mappings.default_on_attach(bufnr)

	-- 2. Add your custom single-click mapping
	vim.keymap.set("n", "<LeftRelease>", function()
		-- Select the node under the mouse before opening
		vim.cmd([[ execute "normal! \<LeftMouse>" ]])
		local node = api.tree.get_node_under_cursor()

		if node then
			api.node.open.edit()
		end
	end, { buffer = bufnr, noremap = true, silent = true, desc = "Open on click" })
end

require("nvim-tree").setup({
	filters = {
		git_ignored = false, -- Disable hiding .gitignored files/dirs
	},
	update_focused_file = {
		enable = true, -- Have nvim-tree's selected file match the open buffer
	},
	view = {
		side = "right",
		adaptive_size = true,
	},
	on_attach = on_attach,
})

-- Auto refresh/reload nvim-tree on focus (ensures commit/push state is always latest)
-- Create an augroup to prevent duplicate autocommands on reload
local nvim_tree_group = vim.api.nvim_create_augroup("NvimTreeRefresh", { clear = true })

vim.api.nvim_create_autocmd("BufEnter", {
	group = nvim_tree_group,
	pattern = "NvimTree_*", -- Matches the NvimTree buffer naming convention
	callback = function()
		require("nvim-tree.api").tree.reload()
	end,
})
