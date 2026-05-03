-- Status line (bottom) + winbar (per-window filename at top of each split)
vim.pack.add({ {
  src = 'https://github.com/nvim-lualine/lualine.nvim',
  version = 'master'
} })

-- Customize the rose-pine theme so every section has a visible background.
-- lualine_a (mode) reacts to mode; all other sections use a consistent overlay bg.
local colors = {
  base    = '#191724',
  overlay = '#26233a',
  pine    = '#31748f',
  foam    = '#9ccfd8',
  iris    = '#c4a7e7',
  rose    = '#ebbcba',
  gold    = '#f6c177',
  love    = '#eb6f92',
  text    = '#e0def4',
  subtle  = '#908caa',
  muted   = '#6e6a86',
}

local theme = {
  normal   = { a = { bg = colors.pine, fg = colors.base, gui = 'bold' } },
  insert   = { a = { bg = colors.foam, fg = colors.base, gui = 'bold' } },
  visual   = { a = { bg = colors.iris, fg = colors.base, gui = 'bold' } },
  replace  = { a = { bg = colors.love, fg = colors.base, gui = 'bold' } },
  command  = { a = { bg = colors.gold, fg = colors.base, gui = 'bold' } },
  inactive = { a = { bg = colors.overlay, fg = colors.muted } },
}

-- All non-mode sections share the same solid overlay background
for _, mode in pairs(theme) do
  mode.b = { bg = colors.overlay, fg = colors.text }
  mode.c = { bg = colors.overlay, fg = colors.subtle }
end

require('lualine').setup({
  options = {
    theme = theme,
    globalstatus = true,
    disabled_filetypes = {
      winbar = { 'NvimTree', 'fugitive', '' },
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
    lualine_z = { 'location' },       -- line:col, far right
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
        color = { bg = colors.pine, fg = colors.text },
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
        color = { bg = colors.overlay, fg = colors.muted },
      },
    },
  },
})
