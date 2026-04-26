-- VS Code-like Diff and Merge View
vim.pack.add({ {
  src = 'https://github.com/dlyongemallo/diffview.nvim',
  version = 'v0.31'
} })

local function toggle_diffview()
  local lib = require("diffview.lib")
  if lib.get_current_view() then
    vim.cmd("DiffviewClose")
  else
    vim.cmd("DiffviewOpen")
  end
end

vim.keymap.set("n", "<leader>gd", toggle_diffview, { desc = "Toggle Diffview" })
