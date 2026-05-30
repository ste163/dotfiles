-- Browser-based markdown preview with Mermaid and scroll syncing
vim.pack.add({
  { src = "https://github.com/selimacerbas/live-server.nvim" },
  { src = "https://github.com/selimacerbas/markdown-preview.nvim", version = "v1.9.0" },
})

require("markdown_preview").setup({
  instance_mode = "takeover",
  port = 0,
  open_browser = true,
  default_theme = "dark",
  debounce_ms = 300,
})

vim.keymap.set("n", "<leader>mps", "<cmd>MarkdownPreview<cr>", { desc = "Markdown: Start preview" })
vim.keymap.set("n", "<leader>mpS", "<cmd>MarkdownPreviewStop<cr>", { desc = "Markdown: Stop preview" })
vim.keymap.set("n", "<leader>mpr", "<cmd>MarkdownPreviewRefresh<cr>", { desc = "Markdown: Refresh preview" })
