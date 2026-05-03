-- Status line (bottom) + winbar (per-window filename at top of each split)
vim.pack.add({ {
  src = 'https://github.com/nvim-lualine/lualine.nvim',
  version = 'master'
} })

require('lualine').setup({
  options = {
    theme = 'rose-pine',
    globalstatus = true,
    disabled_filetypes = {
      winbar = { 'NvimTree', 'fugitive', '' }, -- '' catches terminal buffers (they have no filetype)
    },
  },

  sections = {
    lualine_a = { 'mode' },
    lualine_b = { 'branch', 'diff', 'diagnostics' },
    lualine_c = { 'filename' },
    lualine_x = { 'encoding', 'fileformat', 'filetype' },
    lualine_y = { 'progress' },
    lualine_z = { 'location' },
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
        color = { bg = '#31748f' },
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
        color = { fg = '#6e6a86' },
      },
    },
  },
})
