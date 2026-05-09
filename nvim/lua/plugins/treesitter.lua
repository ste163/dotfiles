-- Native treesitter setup for Neovim 0.12+
-- Bundled parsers: c, lua, markdown, vimdoc, vim
-- Additional parsers below are installed automatically on first startup using tree-sitter-cli.
--
-- To update parsers:
--   :TSUpdate        — rebuild all managed parsers
--   :TSUpdate yaml   — rebuild a single parser
--   :TSStatus        — show load/query status of all managed parsers
--
-- To force-reinstall manually (without the commands above):
--   1. Delete the parser: rm ~/.local/share/nvim/site/parser/{lang}.so
--   2. Delete the queries: rm -r ~/.local/share/nvim/site/queries/{lang}
--   3. Restart nvim — both will be reinstalled automatically.

-- tsx requires an explicit filetype registration because neovim's filetype
-- for .tsx files is 'typescriptreact', not 'tsx'.
vim.treesitter.language.register("tsx", "typescriptreact")

-- ---------------------------------------------------------------------------
-- Predicate polyfills
--
-- Query files sourced directly from tree-sitter language repos sometimes use
-- predicates that are part of the tree-sitter standard but are NOT implemented
-- in neovim's treesitter engine. Without a registered handler, neovim throws:
--   "Decoration provider: No handler for <predicate>"
-- on every buffer scroll, spamming the message area.
--
-- The fix is vim.treesitter.query.add_predicate(name, fn, { force = true }).
-- Each handler receives (match, pattern, source, predicate, metadata) and must
-- return true (node passes the filter) or false (node is excluded).
--
-- Neovim 0.12.2 built-in predicates (for reference):
--   eq?, any-eq?, match?, any-match?, vim-match?, any-vim-match?,
--   lua-match?, any-lua-match?, contains?, any-contains?, any-of?,
--   has-ancestor?, has-parent?
--   (all support a "not-" prefix, e.g. not-eq?, not-match?)
--
-- If you install a new language and start seeing "No handler for <name>?":
--   1. Find which query file uses it:
--        grep -r "<name>?" ~/.local/share/nvim/site/queries/
--   2. Check what the predicate guards — does passing (true) or failing (false)
--      produce better default behavior?
--   3. Add a polyfill below with a comment explaining the trade-off.
-- ---------------------------------------------------------------------------

-- #is-not? is a tree-sitter standard predicate used to gate a capture on scope
-- context (e.g. "only tag as @variable.builtin if not a local variable").
-- Neovim 0.12.2 does not implement it; returning true means "assume not local",
-- so builtins like console/require still highlight. The only trade-off is that
-- a locally-shadowed builtin (e.g. `const console = ...`) will still be colored
-- as a builtin — an acceptable cosmetic edge case.
vim.treesitter.query.add_predicate("is-not?", function()
	return true
end, { force = true })

-- Enable treesitter highlighting for every buffer that has a parser available.
-- Fails silently (pcall) when no parser exists for the current filetype.
vim.api.nvim_create_autocmd("FileType", {
	callback = function(ev)
		pcall(vim.treesitter.start, ev.buf)
	end,
})

-- Parsers that must be built and placed in the parser runtime directory.
-- Neovim only bundles parsers for: c, lua, markdown, markdown_inline, vim, vimdoc.
-- All others need external install — both the .so parser AND the queries/ directory.
--
-- Entry fields:
--   lang          — parser name
--   repo          — git repo URL
--   subdir        — subdirectory inside repo containing the grammar (optional)
--   queries_rel   — path inside tmp_dir to the queries/ folder (default: 'queries')
--   queries_prepend — line prepended to highlights.scm, e.g. '; inherits: javascript'
--
-- Multi-entries clone the repo once and build multiple parsers (e.g. tree-sitter-typescript).
-- Multi sub-parser extra fields are the same as single entries:
--   queries_rel     — path inside tmp_dir to copy queries from (default: 'queries')
--   queries_prepend — line prepended to highlights.scm
local parsers = {
	{ lang = "html", repo = "https://github.com/tree-sitter/tree-sitter-html" },
	{ lang = "json", repo = "https://github.com/tree-sitter/tree-sitter-json" },
	{ lang = "javascript", repo = "https://github.com/tree-sitter/tree-sitter-javascript" },
	{
		-- tree-sitter-typescript ships two grammars in one repo.
		-- The repo root queries/ are intentionally designed for BOTH the typescript
		-- and tsx parsers. We copy them directly to each language's queries dir so
		-- that each parser compiles the queries against its own grammar — no chain.
		-- Both inherit javascript for base JS highlighting.
		repo = "https://github.com/tree-sitter/tree-sitter-typescript",
		multi = {
			{
				lang = "typescript",
				subdir = "typescript",
				queries_rel = "queries", -- root of repo
				queries_prepend = "; inherits: (javascript)",
			},
			{
				lang = "tsx",
				subdir = "tsx",
				queries_rel = "queries", -- same shared queries, compiled for tsx grammar
				queries_prepend = "; inherits: (javascript)",
			},
		},
	},
	{ lang = "css", repo = "https://github.com/tree-sitter/tree-sitter-css" },
	{ lang = "yaml", repo = "https://github.com/tree-sitter-grammars/tree-sitter-yaml" },
	{ lang = "dockerfile", repo = "https://github.com/camdencheek/tree-sitter-dockerfile" },
	{ lang = "python", repo = "https://github.com/tree-sitter/tree-sitter-python" },
}

-- Both directories live under site/ which is in neovim's runtimepath by default.
local parser_dir = vim.fn.stdpath("data") .. "/site/parser"
local queries_dir = vim.fn.stdpath("data") .. "/site/queries"
vim.fn.mkdir(parser_dir, "p")
vim.fn.mkdir(queries_dir, "p")

-- Returns a flat list of all individual {lang, repo, subdir} specs for tab-completion / status.
local function flat_parsers()
	local result = {}
	for _, entry in ipairs(parsers) do
		if entry.multi then
			for _, p in ipairs(entry.multi) do
				table.insert(result, { lang = p.lang, repo = entry.repo, subdir = p.subdir })
			end
		else
			table.insert(result, entry)
		end
	end
	return result
end

-- Copy all .scm files from src_dir into queries_dir/lang/.
-- If prepend is set, it is inserted as the first line of highlights.scm.
-- Must be called on the main thread (uses vim.fn.*).
local function install_queries(src_dir, lang, prepend)
	if vim.fn.isdirectory(src_dir) == 0 then
		vim.notify("treesitter: no queries directory found for " .. lang .. " at " .. src_dir, vim.log.levels.WARN)
		return
	end
	local dest = queries_dir .. "/" .. lang
	vim.fn.mkdir(dest, "p")
	for _, src_file in ipairs(vim.fn.glob(src_dir .. "/*.scm", false, true)) do
		local fname = vim.fn.fnamemodify(src_file, ":t")
		local lines = vim.fn.readfile(src_file)
		if prepend and fname == "highlights.scm" then
			table.insert(lines, 1, prepend)
		end
		vim.fn.writefile(lines, dest .. "/" .. fname)
	end
end

-- True only when both the parser .so is loadable AND a queries directory exists.
-- This is the skip condition for installs (avoids redundant clones on every startup).
local function is_ready(lang)
	return vim.treesitter.language.add(lang) == true and vim.fn.isdirectory(queries_dir .. "/" .. lang) ~= 0
end

-- Build one parser .so from an already-cloned tmp_dir.
-- MUST be called from the main thread (vim.schedule or vim.defer_fn) — notifies immediately.
-- on_done(success) is called back on the main thread via vim.schedule.
local function build_one(lang, tmp_dir, subdir, on_done)
	local parser_file = parser_dir .. "/" .. lang .. ".so"
	local build_path = subdir and (tmp_dir .. "/" .. subdir) or tmp_dir
	vim.notify("treesitter: building " .. lang .. "...", vim.log.levels.INFO)
	vim.system({ "tree-sitter", "build", "--output", parser_file, build_path }, { text = true }, function(result)
		vim.schedule(function()
			if result.code ~= 0 then
				vim.notify("treesitter: build failed for " .. lang, vim.log.levels.WARN)
				on_done(false)
			else
				vim.notify("treesitter: installed " .. lang .. " parser", vim.log.levels.INFO)
				on_done(true)
			end
		end)
	end)
end

-- Install (or force-update) one entry from the parsers table.
-- Handles both single-parser and multi-parser (one repo, many grammars) entries.
local function install_entry(entry, force)
	if entry.multi then
		if not force then
			local all_ready = true
			for _, p in ipairs(entry.multi) do
				if not is_ready(p.lang) then
					all_ready = false
					break
				end
			end
			if all_ready then
				return
			end
		end

		local tmp_dir = vim.fn.tempname()
		vim.notify("treesitter: cloning " .. entry.repo:match("[^/]+$") .. "...", vim.log.levels.INFO)
		vim.system({ "git", "clone", "--depth=1", entry.repo, tmp_dir }, { text = true }, function(clone_result)
			-- Switch to main thread: vim.fn calls and build_one require it.
			vim.schedule(function()
				if clone_result.code ~= 0 then
					vim.notify("treesitter: clone failed for " .. entry.repo, vim.log.levels.WARN)
					return
				end

				-- Install queries for each sub-parser before building.
				for _, p in ipairs(entry.multi) do
					local rel = p.queries_rel or "queries"
					install_queries(tmp_dir .. "/" .. rel, p.lang, p.queries_prepend)
				end

				-- Build all parsers; delete tmp_dir only after the last one finishes.
				local remaining = #entry.multi
				for _, p in ipairs(entry.multi) do
					build_one(p.lang, tmp_dir, p.subdir, function()
						remaining = remaining - 1
						if remaining == 0 then
							vim.fn.delete(tmp_dir, "rf")
						end
					end)
				end
			end)
		end)
	else
		if not force and is_ready(entry.lang) then
			return
		end

		local tmp_dir = vim.fn.tempname()
		vim.notify("treesitter: cloning " .. entry.lang .. "...", vim.log.levels.INFO)
		vim.system({ "git", "clone", "--depth=1", entry.repo, tmp_dir }, { text = true }, function(clone_result)
			vim.schedule(function()
				if clone_result.code ~= 0 then
					vim.notify("treesitter: clone failed for " .. entry.lang, vim.log.levels.WARN)
					return
				end

				-- Copy queries, then build the parser.
				local rel = entry.queries_rel or "queries"
				install_queries(tmp_dir .. "/" .. rel, entry.lang, entry.queries_prepend)

				local parser_file = parser_dir .. "/" .. entry.lang .. ".so"
				local build_path = entry.subdir and (tmp_dir .. "/" .. entry.subdir) or tmp_dir
				vim.notify("treesitter: building " .. entry.lang .. "...", vim.log.levels.INFO)
				vim.system(
					{ "tree-sitter", "build", "--output", parser_file, build_path },
					{ text = true },
					function(build_result)
						vim.schedule(function()
							vim.fn.delete(tmp_dir, "rf")
							if build_result.code ~= 0 then
								vim.notify("treesitter: build failed for " .. entry.lang, vim.log.levels.WARN)
							else
								vim.notify("treesitter: installed " .. entry.lang .. " parser", vim.log.levels.INFO)
							end
						end)
					end
				)
			end)
		end)
	end
end

local function check_cli()
	if vim.fn.exepath("tree-sitter") == "" then
		vim.notify(
			"treesitter: tree-sitter-cli not found in PATH — parser install/update skipped.",
			vim.log.levels.WARN
		)
		return false
	end
	return true
end

-- Install any missing parsers + queries asynchronously after startup.
-- On subsequent launches this is a no-op (is_ready guard above).
vim.defer_fn(function()
	if not check_cli() then
		return
	end
	for _, entry in ipairs(parsers) do
		install_entry(entry)
	end
end, 100)

-- :TSUpdate [lang]  — rebuild one or all managed parsers (and their queries) from source.
vim.api.nvim_create_user_command("TSUpdate", function(opts)
	if not check_cli() then
		return
	end
	local lang = opts.args ~= "" and opts.args or nil
	if lang then
		local found = false
		for _, entry in ipairs(parsers) do
			if entry.multi then
				for _, p in ipairs(entry.multi) do
					if p.lang == lang then
						-- Re-use the full multi-entry so queries are also updated.
						install_entry(entry, true)
						found = true
						break
					end
				end
			elseif entry.lang == lang then
				install_entry(entry, true)
				found = true
			end
			if found then
				break
			end
		end
		if not found then
			vim.notify('treesitter: unknown parser "' .. lang .. '"', vim.log.levels.WARN)
		end
	else
		for _, entry in ipairs(parsers) do
			install_entry(entry, true)
		end
	end
end, {
	nargs = "?",
	complete = function()
		return vim.tbl_map(function(p)
			return p.lang
		end, flat_parsers())
	end,
})

-- :TSStatus — show load + query status for all managed parsers.
vim.api.nvim_create_user_command("TSStatus", function()
	local lines = { "Treesitter parser status:", "" }
	for _, p in ipairs(flat_parsers()) do
		local parser_ok = vim.treesitter.language.add(p.lang) == true
		local queries_ok = vim.fn.isdirectory(queries_dir .. "/" .. p.lang) ~= 0
		local status
		if parser_ok and queries_ok then
			status = "✓ ready"
		elseif parser_ok then
			status = "~ parser ok, queries missing"
		elseif queries_ok then
			status = "~ queries ok, parser missing"
		else
			status = "✗ not installed"
		end
		table.insert(lines, string.format("  %-14s %s", p.lang, status))
	end
	vim.notify(table.concat(lines, "\n"), vim.log.levels.INFO)
end, {})
