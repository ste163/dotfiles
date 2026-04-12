-- More robust undo and redo feature with long history
vim.pack.add({ {
  src = 'https://github.com/mbbill/undotree',
  version = 'rel_6.1'
} })

vim.keymap.set("n", "<leader>u", vim.cmd.UndotreeToggle, { desc = 'Open Undotree' })
