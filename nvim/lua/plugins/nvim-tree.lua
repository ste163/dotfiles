-- File tree manager. Replacement for the builtin one (netrw)
vim.pack.add({ {
  src = "https://github.com/nvim-tree/nvim-tree.lua",
  version = "531b807b8f0d6f75016a0ee1e0cd5ce2086e9d95", -- v1.18.0
} })

local function on_attach(bufnr)
  local api = require("nvim-tree.api")

  -- 1. Load default mappings so <CR>, <C-v>, etc. still work
  api.config.mappings.default_on_attach(bufnr)

  -- 2. Add your custom single-click mapping
  vim.keymap.set("n", "<LeftRelease>", function()
    -- Select the node under the mouse before opening
    vim.cmd([[ execute "normal! \<LeftMouse>" ]])
    local node = api.tree.get_node_under_cursor()

    if node then
      api.node.open.edit()
    end
  end, { buffer = bufnr, noremap = true, silent = true, desc = "Open on click" })
end

require("nvim-tree").setup({
  filters = {
    git_ignored = false, -- Disable hiding .gitignored files/dirs
  },
  update_focused_file = {
    enable = true, -- Have nvim-tree's selected file match the open buffer
  },
  view = {
    side = "right",
    -- adaptive sizing: the tree grows toward the longest
    -- visible filename, clamped between min and max. Percentages resolve
    -- against vim.o.columns, so the cap scales per machine/pane size.
    width = {
      min = 30,    -- floor for shallow folders
      max = "40%", -- ceiling: never eat more than 40% of the editor
    },
  },
  on_attach = on_attach,
})
