-- Theme
vim.pack.add({ {
  src = "https://github.com/rose-pine/neovim",
  version = "v3.0.2",
} })

require("rose-pine").setup({
  variant = "moon",      -- auto, main, moon, or dawn
  dark_variant = "moon", -- main, moon, or dawn
  dim_inactive_windows = false,
  extend_background_behind_borders = true,

  enable = {
    terminal = true,
    legacy_highlights = false, -- Set to True to improve compatibility for previous versions of Neovim
    migrations = true,         -- Handle deprecated options automatically
  },

  styles = {
    bold = true,
    italic = true,
    transparency = true,
  },

  groups = {
    border = "muted",
    link = "iris",
    panel = "surface",

    error = "love",
    hint = "iris",
    info = "foam",
    note = "pine",
    todo = "rose",
    warn = "gold",

    git_add = "foam",
    git_change = "rose",
    git_delete = "love",
    git_dirty = "rose",
    git_ignore = "muted",
    git_merge = "iris",
    git_rename = "pine",
    git_stage = "iris",
    git_text = "rose",
    git_untracked = "subtle",

    h1 = "iris",
    h2 = "foam",
    h3 = "rose",
    h4 = "gold",
    h5 = "pine",
    h6 = "foam",
  },
})

-- Activate theme
vim.cmd("colorscheme rose-pine-moon")

-- Setup the cursor line to match the mode
local function setup_blended_cursorline()
  local p = require("rose-pine.palette")
  local bg = p.base -- Rosé Pine base: #191724

  -- Helper to manually blend colors at 10% (0.1 alpha)
  local function blend(foreground, alpha)
    local function hex_to_rgb(hex)
      return tonumber(hex:sub(2, 3), 16), tonumber(hex:sub(4, 5), 16), tonumber(hex:sub(6, 7), 16)
    end
    local r1, g1, b1 = hex_to_rgb(foreground)
    local r2, g2, b2 = hex_to_rgb(bg)
    local r = math.floor(r1 * alpha + r2 * (1 - alpha))
    local g = math.floor(g1 * alpha + g2 * (1 - alpha))
    local b = math.floor(b1 * alpha + b2 * (1 - alpha))
    return string.format("#%02x%02x%02x", r, g, b)
  end

  -- Pre-calculated 10% blends
  local normal_bg = blend(p.foam, 0.1) -- Subtle Blue/Teal
  local insert_bg = blend(p.pine, 0.2) -- Subtle Green
  local visual_bg = blend(p.iris, 0.1) -- Subtle Purple

  vim.opt.cursorline = true

  local group = vim.api.nvim_create_augroup("CursorLineModes", { clear = true })

  -- Set Normal color initially
  vim.api.nvim_set_hl(0, "CursorLine", { bg = normal_bg })

  -- 1. Enter Insert
  vim.api.nvim_create_autocmd("InsertEnter", {
    group = group,
    callback = function()
      vim.api.nvim_set_hl(0, "CursorLine", { bg = insert_bg })
    end,
  })

  -- 2. Enter Visual (any variant)
  vim.api.nvim_create_autocmd("ModeChanged", {
    group = group,
    pattern = "*:[vV\x16]*",
    callback = function()
      vim.api.nvim_set_hl(0, "CursorLine", { bg = visual_bg })
    end,
  })

  -- 3. The RESET: Trigger when entering Normal mode (n) from ANY other mode
  vim.api.nvim_create_autocmd("ModeChanged", {
    group = group,
    pattern = "*:n",
    callback = function()
      vim.api.nvim_set_hl(0, "CursorLine", { bg = normal_bg })
    end,
  })
end

-- Use pcall to prevent errors if the theme hasn't loaded palette yet
pcall(setup_blended_cursorline)
