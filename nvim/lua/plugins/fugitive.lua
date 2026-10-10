-- Git integration
vim.pack.add({ {
  src = 'https://github.com/tpope/vim-fugitive',
  version = '3b753cf8c6a4dcde6edee8827d464ba9b8c4a6f0', -- master
} })

vim.keymap.set("n", "<leader>gs", vim.cmd.Git, { desc = 'Open Fugitive (git status)' })
