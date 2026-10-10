-- Git integration
vim.pack.add({ {
  src = 'https://github.com/tpope/vim-fugitive',
  version = '3b753cf8c6a4dcde6edee8827d464ba9b8c4a6f0', -- master
} })

vim.keymap.set("n", "<leader>gs", vim.cmd.Git, { desc = 'Open Fugitive (git status)' })

-- After leaving the commit message window, reopen the status window
vim.api.nvim_create_autocmd("BufDelete", {
  callback = function()
    local bufnr = tonumber(vim.fn.expand("<abuf>"))
    if vim.bo[bufnr].filetype == "gitcommit" and not vim.v.exiting then
      vim.schedule(function()
        vim.cmd.Git()
      end)
    end
  end,
})
