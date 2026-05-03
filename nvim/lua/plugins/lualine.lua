-- Status line (bottom) + winbar (per-window filename at top of each split)
vim.pack.add({ {
  src = 'https://github.com/nvim-lualine/lualine.nvim',
  version = 'master'
} })

local p = require('rose-pine.palette')

local theme = {
  normal   = { a = { bg = p.pine, fg = p.base, gui = 'bold' } },
  insert   = { a = { bg = p.foam, fg = p.base, gui = 'bold' } },
  visual   = { a = { bg = p.iris, fg = p.base, gui = 'bold' } },
  replace  = { a = { bg = p.love, fg = p.base, gui = 'bold' } },
  command  = { a = { bg = p.gold, fg = p.base, gui = 'bold' } },
  inactive = { a = { bg = p.overlay, fg = p.muted } },
}

-- All non-mode sections share the same solid overlay background
for _, mode in pairs(theme) do
  mode.b = { bg = p.surface, fg = p.text }
  mode.c = { bg = p.surface, fg = p.subtle }
end

require('lualine').setup({
  options = {
    theme = theme,
    globalstatus = true,
    disabled_filetypes = {
      winbar = { 'NvimTree', 'fugitive', 'DiffviewFiles', 'DiffviewFileHistory', '' },
    },
    -- Flat separators everywhere except the mode pill (lualine_a keeps its block style
    -- via the theme; section_separators controls the arrows between sections)
    section_separators = { left = '', right = '' },
    component_separators = { left = '│', right = '│' },
  },

  sections = {
    lualine_a = { 'mode' },           -- changes color per mode (normal/insert/visual)
    lualine_b = { 'branch', 'diff' }, -- git info, flat solid color
    lualine_c = { 'diagnostics' },    -- errors/warnings
    lualine_x = {},                   -- empty middle
    lualine_y = { 'filetype' },       -- language  like VS Code bottom-right
    lualine_z = { 'progress', 'location' }, -- % through file, line:col, far right
  },
  inactive_sections = {
    lualine_a = {},
    lualine_b = {},
    lualine_c = { 'filename' },
    lualine_x = { 'location' },
    lualine_y = {},
    lualine_z = {},
  },

  winbar = {
    lualine_c = {
      {
        'filename',
        path = 0,
        file_status = true,
        shorting_target = 40,
        symbols = {
          modified = '',
          readonly = '[-]',
          unnamed  = '[No Name]',
        },
        color = { bg = p.pine, fg = p.text },
      },
    },
  },

  inactive_winbar = {
    lualine_c = {
      {
        'filename',
        path = 0,
        file_status = true,
        symbols = {
          modified = '',
          readonly = '[-]',
          unnamed  = '[No Name]',
        },
        color = { bg = p.surface, fg = p.muted },
      },
    },
  },
})
