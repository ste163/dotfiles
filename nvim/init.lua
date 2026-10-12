vim.g.loaded_netrw = 1 -- turn netrw off and only use nvimtree
vim.g.loaded_netrwPlugin = 1

-- Optional: If you see progress bars as garbage text, try forcing the terminal type
vim.env.TERM = "xterm-256color"
require("config.options")
require("config.keymap")

require("plugins.telescope")
require("plugins.treesitter")
require("plugins.lsp")
require("plugins.conform")
require("plugins.nvim-tree")
require("plugins.fugitive")
require("plugins.diffview")
require("plugins.gitsigns")
require("plugins.mini-animate")

require("plugins.rose-pine")        -- must be before lualine so its palette is available
require("plugins.markdown-preview") -- needs to be below theme
require("plugins.lualine")          -- uses rose-pine.palette, so rose-pine must load first
require("plugins.native-image")     -- replaces vim.ui.img with the tmux-passthrough backend
require("plugins.which-key")        -- should be last to load all keybinds

local fugitive_group = vim.api.nvim_create_augroup("FugitiveTerminalFix", { clear = true })

-- Fugitive commit and push flow:
--   cc              -> real terminal running `git commit -v`, flagged as the commit terminal
--   TermClose       -> closes the flagged terminal on success and reopens :Git
--   FugitiveChanged -> closes the status window after a successful push

-- Replace fugitive's built-in cc (in-buffer commit UI) with a real
-- terminal. The terminal buffer is flagged because TermClose has no way
-- to tell what a terminal was running.
vim.api.nvim_create_autocmd("FileType", {
  group = fugitive_group,
  pattern = "fugitive",
  callback = function()
    vim.keymap.set("n", "cc", function()
      vim.cmd("term git commit -v")
      local buf = vim.api.nvim_get_current_buf()
      vim.b[buf].fugitive_commit_terminal = true
    end, { buffer = true, silent = true })
  end,
})

-- Applies to every terminal: start in insert mode so typing reaches the
-- shell immediately, and drop line numbers.
vim.api.nvim_create_autocmd("TermOpen", {
  group = fugitive_group,
  callback = function()
    vim.cmd("startinsert")
    vim.opt_local.number = false
    vim.opt_local.relativenumber = false
  end,
})

-- Only the flagged commit terminal is auto-managed. Success: close it
-- and reopen the status window. Failure: leave it open so the error is
-- visible. All other terminals exit untouched.
vim.api.nvim_create_autocmd("TermClose", {
  group = fugitive_group,
  callback = function()
    local buf = tonumber(vim.fn.expand("<abuf>"))
    if not vim.b[buf].fugitive_commit_terminal then
      return
    end
    if vim.v.event.status == 0 then
      vim.api.nvim_buf_delete(buf, { force = true })
      vim.schedule(function()
        vim.cmd.Git()
      end)
    end
  end,
})

-- Close the status window after a successful push. FugitiveResult() is
-- event-scoped: it holds the triggering :Git job only when this event
-- came from that job completing. Staging reloads fire the same event
-- with no result attached, so reading the session-wide
-- g:_fugitive_last_job here would close the window on unrelated actions.
vim.api.nvim_create_autocmd("User", {
  group = fugitive_group,
  pattern = "FugitiveChanged",
  callback = function()
    local job = vim.fn.FugitiveResult()
    if type(job) ~= "table" or type(job.args) ~= "table" or not vim.tbl_contains(job.args, "push") or job.exit_status ~= 0 then
      return
    end
    local targets = {}
    if type(job.git_dir) == "string" then
      table.insert(targets, "fugitive://" .. job.git_dir .. "//")
    end
    if type(job.file) == "string" then
      table.insert(targets, job.file)
    end
    vim.schedule(function()
      for _, win in ipairs(vim.api.nvim_list_wins()) do
        local name = vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(win))
        if vim.tbl_contains(targets, name) then
          vim.api.nvim_win_close(win, true)
        end
      end
    end)
  end,
})
