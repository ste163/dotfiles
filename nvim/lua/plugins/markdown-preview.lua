-- Browser-based markdown preview with Mermaid and scroll syncing.
-- Renamed upstream: markdown-preview.nvim -> mdkite.nvim, live-server.nvim ->
-- kitehost.nvim. Old spec URLs still install via GitHub redirects; module and
-- commands use the new names (old ones are removed in 3.0.0).
vim.pack.add({
  { src = "https://github.com/selimacerbas/live-server.nvim",
    version = "4cb5c94a84cc653e0b32e0c9aed95465a36fc94d" }, -- v2.0.0 (kitehost)
  { src = "https://github.com/selimacerbas/markdown-preview.nvim",
    version = "dded03dc6cce87364b48260b2ffbace575a6add7" }, -- v2.1.0 (mdkite)
})

require("mdkite").setup({
  instance_mode = "takeover",
  port = 0,
  open_browser = true,
  default_theme = "dark",
  debounce_ms = 300,
})

vim.keymap.set("n", "<leader>mps", "<cmd>MdKite start<cr>", { desc = "Markdown: Start preview" })
vim.keymap.set("n", "<leader>mpS", "<cmd>MdKite stop<cr>", { desc = "Markdown: Stop preview" })
vim.keymap.set("n", "<leader>mpr", "<cmd>MdKite refresh<cr>", { desc = "Markdown: Refresh preview" })
