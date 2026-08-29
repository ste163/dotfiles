-- Fuzzy file finder in a command palette view

-- ---------------------------------------------------------------------------
-- fzf-native: C port of fzf used as telescope's sorter — much faster than the
-- default Lua sorter on large result sets, and adds fzf search syntax in
-- every picker:  'exact  !inverse  ^prefix  $suffix  | (OR)
--
-- nvim-pack has no build hooks, so the extension's libfzf.so is built here:
--   1. PackChanged autocmd below — rebuilds whenever nvim-pack (re)installs
--      or updates the plugin. Needed on update: git checkout keeps the old
--      untracked build/, which would otherwise silently stay a stale binary.
--   2. Startup check after setup() — self-heals "installed but never built"
--      on any machine pulling this config. PackChanged alone can't do this:
--      an already-installed plugin at its locked rev never fires an event.
-- Registered before vim.pack.add() so lockfile-driven fresh-machine installs
-- are caught too (see :h vim.pack-events).
-- ---------------------------------------------------------------------------

local fzf_building = false

-- Build the extension (async) and activate it live, without a restart.
-- The in-flight guard keeps the two triggers (install event + startup check)
-- from racing two `make`s in the same directory.
local function ensure_fzf_built(path, reason)
	if fzf_building then
		return
	end
	fzf_building = true
	local ok_spawn = pcall(vim.system, { "make" }, { cwd = path, text = true }, function(res)
		vim.schedule(function()
			fzf_building = false
			if res.code ~= 0 then
				vim.notify("fzf-native: build failed — telescope keeps its default sorter", vim.log.levels.WARN)
				return
			end
			vim.notify("fzf-native: built (" .. reason .. ") — fzf sorter active", vim.log.levels.INFO)
			pcall(require("telescope").load_extension, "fzf")
		end)
	end)
	if not ok_spawn then
		fzf_building = false
		vim.notify("fzf-native: could not run `make` (installed?) — telescope keeps its default sorter", vim.log.levels.WARN)
	end
end

-- Rebuild whenever nvim-pack installs or updates the extension
vim.api.nvim_create_autocmd("PackChanged", {
	group = vim.api.nvim_create_augroup("FzfNativeBuild", { clear = true }),
	callback = function(ev)
		if ev.data.spec.name ~= "telescope-fzf-native.nvim" then
			return
		end
		if ev.data.kind ~= "install" and ev.data.kind ~= "update" then
			return
		end
		ensure_fzf_built(ev.data.path, ev.data.kind)
	end,
})

vim.pack.add({
	{
		src = "https://github.com/nvim-lua/plenary.nvim",
		version = "v0.1.4",
	},
	{
		src = "https://github.com/nvim-telescope/telescope.nvim",
		version = "v0.2.1",
	},
	{
		src = "https://github.com/nvim-telescope/telescope-fzf-native.nvim",
	},
})

require("telescope").setup({
    pickers = {
        find_files = {
            hidden = true,
            file_ignore_patterns = { ".git/" },
        },
    },
    extensions = {
        -- All values are fzf-native's defaults — kept explicit for documentation
        -- ("only the loading is important" per its README)
        fzf = {
            fuzzy = true, -- false = exact matching only
            override_generic_sorter = true, -- use for live_grep, lsp_*, etc.
            override_file_sorter = true, -- use for find_files and file pickers
            case_mode = "smart_case", -- matches 'ignorecase' + 'smartcase'
        },
    },
})

-- Load the fzf sorter if it is already built; if not, warn (no silent
-- fallback) and build it now — it goes live a few seconds later.
local loaded_fzf = pcall(require("telescope").load_extension, "fzf")
if not loaded_fzf then
	vim.notify("fzf-native: not built yet — building now, default sorter until it is active", vim.log.levels.WARN)
	local path = vim.pack.get({ "telescope-fzf-native.nvim" }, { info = false })[1].path
	ensure_fzf_built(path, "startup")
end

local builtin = require("telescope.builtin")

vim.keymap.set("n", "<leader>ff", builtin.find_files, { desc = "Telescope find files" })
vim.keymap.set("n", "<leader>fa", builtin.live_grep, { desc = "Telescope find all instances of text" })
