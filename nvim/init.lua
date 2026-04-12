vim.g.loaded_netrw = 1 -- turn netrw off and only use nvimtree
vim.g.loaded_netrwPlugin = 1

require('config.options')
require('config.keymap')

require('plugins.telescope')
require('plugins.treesitter')
require('plugins.lsp')
require('plugins.conform')
require('plugins.nvim-tree')
require('plugins.undotree')
require('plugins.fugitive')

require('plugins.lualine')
require('plugins.rose-pine') -- may also need to be low to ensure theme is applied properly
require('plugins.which-key') -- should be last to load all keybinds
