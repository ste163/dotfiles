-- Git integration
vim.pack.add({ {
  src = 'https://github.com/tpope/vim-fugitive'
} })

vim.keymap.set("n", "<leader>gs", vim.cmd.Git, { desc = 'Open Fugitive (git status)' })
