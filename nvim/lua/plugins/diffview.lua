-- VS Code-like Diff and Merge View
vim.pack.add({ {
  src = 'https://github.com/dlyongemallo/diffview.nvim',
  version = '875d16dd8c8aa86f1a5c3b5cef49e1133980ae94', -- v0.38
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
