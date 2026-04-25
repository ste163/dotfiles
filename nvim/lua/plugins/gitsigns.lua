-- Integrates Git into the buffer
-- (ie, shows changed files, blame)
vim.pack.add({ {
  src = 'https://github.com/lewis6991/gitsigns.nvim',
  version = 'v2.1.0'
} })

require('gitsigns').setup({
  -- Setup keymaps
  on_attach = function(bufnr)
    local gitsigns = require('gitsigns')

    local function map(mode, l, r, opts)
      opts = opts or {}
      opts.buffer = bufnr
      vim.keymap.set(mode, l, r, opts)
    end

    map('n', '<leader>gb', gitsigns.blame, { desc = 'Open git blame buffer' })
    map('n', '<leader>tb', gitsigns.toggle_current_line_blame, { desc = 'Toggle git blame line' })
  end
})
