-- Adds animations to scrolling, windows
vim.pack.add({ {
  src = "https://github.com/nvim-mini/mini.animate",
} })

-- Fixes mouse scroll breaking if you scroll too quickly
vim.o.mousescroll = "ver:1,hor:0"

local animate = require("mini.animate")

config = {
  cursor = {
    enable = true,
    timing = animate.gen_timing.linear({ duration = 200, unit = "total" }),
  },
  resize = {
    enable = true,
    timing = animate.gen_timing.linear({ duration = 50, unit = "total" }),
  },
}

animate.setup(config)

-- Animate the result of the combined movement commands
-- instead of asynchronously handling each
local smooth_center = function(command)
  return function()
    local keys = vim.api.nvim_replace_termcodes(command, true, false, true)
    -- We use 'm' to avoid re-mapping and 'x' to wait for completion
    vim.api.nvim_feedkeys(keys, "nx", false)
  end
end

-- Keymaps
-- By passing the full string, mini.animate calculates one smooth
-- path to the final 'centered' target line.
vim.keymap.set("n", "<C-d>", smooth_center("<C-d>zz"), { desc = "Smooth centered jump down" })
vim.keymap.set("n", "<C-u>", smooth_center("<C-u>zz"), { desc = "Smooth centered jump up" })
vim.keymap.set("n", "n", smooth_center("nzzzv"), { desc = "Smooth centered search next" })
vim.keymap.set("n", "N", smooth_center("Nzzzv"), { desc = "Smooth centered search prev" })
