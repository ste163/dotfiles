-- Fuzzy file finder in a command palette view
vim.pack.add({
	{
		src = "https://github.com/nvim-lua/plenary.nvim",
		version = "v0.1.4",
	},
	{
		src = "https://github.com/nvim-telescope/telescope.nvim",
		version = "v0.2.1",
	},
	{
		src = "https://github.com/nvim-telescope/telescope-fzf-native.nvim",
	},
})

require("telescope").setup({
    pickers = {
        find_files = {
            hidden = true,
            file_ignore_patterns = { ".git/" },
        },
    },
})

local builtin = require("telescope.builtin")

vim.keymap.set("n", "<leader>ff", builtin.find_files, { desc = "Telescope find files" })
vim.keymap.set("n", "<leader>fa", builtin.live_grep, { desc = "Telescope find all instances of text" })
