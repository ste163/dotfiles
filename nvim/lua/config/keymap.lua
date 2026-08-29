vim.g.mapleader = " " -- space

vim.keymap.set("n", "<leader>fv", vim.cmd.NvimTreeToggle, { desc = "Toggle Nvim Tree" })
vim.keymap.set("n", "q", "<Nop>") -- Disable q from enabling macro recording

vim.keymap.set("v", "J", ":m '>+1<CR>gv=gv", { desc = "Move highlighted section up" })
vim.keymap.set("v", "K", ":m '<-2<CR>gv=gv", { desc = "Move highlighted section down" })

vim.keymap.set("x", "<leader>p", '"_dp', { desc = "Paste but keeps the originally highlighted text" })
vim.keymap.set({ "n", "v" }, "<leader>y", [["+y]], { desc = "Yank to system clipboard" })

vim.keymap.set(
  "n",
  "<leader>s",
  [[:%s/\<<C-r><C-w>\>/<C-r><C-w>/gI<Left><Left><Left>]],
  { desc = "Highlights and replaces all instances of text at the cursor (ie, find and replace all shortcut)" }
)

vim.keymap.set("n", "<leader>x", "<cmd>!chmod +x %<CR>", { desc = "Makes current file executable", silent = true })

vim.keymap.set(
  "n",
  "<leader>t",
  ":botright 20new | term<CR>",
  { desc = "Open a terminal at the bottom of buffer", silent = true }
)

vim.keymap.set(
  "n",
  "<leader>T",
  ":vertical botright vnew | term<CR>",
  { desc = "Open a terminal on the right side", silent = true }
)

vim.keymap.set("t", "<Esc>", [[<C-\><C-n>]], { noremap = true, desc = "Exit the terminal" })

vim.keymap.set("n", "<C-_>", "gcc", { remap = true, desc = "Toggle comments" })
vim.keymap.set("v", "<C-_>", "gc", { remap = true, desc = "Toggle comments" })

-- ---------------------------------------------------------------------------
-- Word wrap / reading mode
--
-- <leader>w toggles word-boundary soft wrap for the current window only.
-- The maps below make navigation display-line aware: gj/gk/g0/g$/g^ are
-- built-in motions that behave exactly like j/k/0/$/^ when wrap is off, so
-- installing them once, globally, is safe. Operator-pending motions (dj, yk,
-- ...) are untouched — edits keep working on real physical lines.
-- ---------------------------------------------------------------------------

local wrap_nav = { silent = true }

vim.keymap.set({ "n", "v" }, "j", "gj", wrap_nav)
vim.keymap.set({ "n", "v" }, "k", "gk", wrap_nav)
vim.keymap.set({ "n", "v" }, "0", "g0", wrap_nav)
vim.keymap.set({ "n", "v" }, "$", "g$", wrap_nav)
vim.keymap.set({ "n", "v" }, "^", "g^", wrap_nav)

local function set_wrap(on)
  vim.wo.wrap = on
  vim.wo.linebreak = on -- wrap at word boundaries (breakat chars), not mid-word
  vim.wo.breakindent = on -- align wrapped lines with the original line's indent
end

-- Toggle flips whatever the current state is, however it got set.
vim.keymap.set("n", "<leader>w", function()
  set_wrap(not vim.wo.wrap)
end, { desc = "Toggle word wrap (window)" })

-- Markdown and prose files read better wrapped. FileType fires once per buffer,
-- so a manual <leader>w override sticks for the life of that window.
vim.api.nvim_create_autocmd("FileType", {
  group = vim.api.nvim_create_augroup("UserWrapDefaults", { clear = true }),
  pattern = { "markdown", "text" },
  callback = function()
    set_wrap(true)
  end,
})

-- LSP keymaps
local keymap = vim.keymap -- for conciseness
vim.api.nvim_create_autocmd("LspAttach", {
  group = vim.api.nvim_create_augroup("UserLspConfig", {}),
  callback = function(ev)
    -- Buffer local mappings.
    -- See `:help vim.lsp.*` for documentation on any of the below functions
    local opts = { buffer = ev.buf, silent = true }

    opts.desc = "Show LSP references"
    keymap.set("n", "gR", "<cmd>Telescope lsp_references<CR>", opts)

    opts.desc = "Go to declaration"
    keymap.set("n", "gD", vim.lsp.buf.declaration, opts)

    opts.desc = "Show LSP definition"
    keymap.set("n", "gd", vim.lsp.buf.definition, opts)

    opts.desc = "Show LSP implementations"
    keymap.set("n", "gi", "<cmd>Telescope lsp_implementations<CR>", opts)

    opts.desc = "Show LSP type definitions"
    keymap.set("n", "gt", "<cmd>Telescope lsp_type_definitions<CR>", opts)

    opts.desc = "See available code actions"
    keymap.set({ "n", "v" }, "<leader>ca", vim.lsp.buf.code_action, opts)

    opts.desc = "Smart rename"
    keymap.set("n", "<leader>rn", vim.lsp.buf.rename, opts)

    opts.desc = "Show buffer diagnostics"
    keymap.set("n", "<leader>D", "<cmd>Telescope diagnostics bufnr=0<CR>", opts)

    opts.desc = "Show line diagnostics"
    keymap.set("n", "<leader>d", vim.diagnostic.open_float, opts)

    opts.desc = "Go to previous diagnostic"
    keymap.set("n", "[d", function()
      vim.diagnostic.jump({ count = -1, float = true })
    end, opts)

    opts.desc = "Go to next diagnostic"
    keymap.set("n", "]d", function()
      vim.diagnostic.jump({ count = 1, float = true })
    end, opts)

    opts.desc = "Show documentation for what is under cursor"
    keymap.set("n", "K", vim.lsp.buf.hover, opts)

    opts.desc = "Restart LSP"
    keymap.set("n", "<leader>rs", ":LspRestart<CR>", opts)
  end,
})
