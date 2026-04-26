-- Native treesitter setup for Neovim 0.12+
-- Bundled parsers: c, lua, markdown, vimdoc, vim
-- Additional parsers below are installed automatically on first startup using tree-sitter-cli.
--
-- To update parsers:
--   :TSUpdate        — rebuild all managed parsers
--   :TSUpdate yaml   — rebuild a single parser
--
-- To force-reinstall manually (without the commands above):
--   1. Delete the parser file: ~/.local/share/nvim/site/parser/{lang}.so
--   2. Restart nvim — it will be cloned and rebuilt automatically.

-- Enable treesitter highlighting for every buffer that has a parser available.
-- Fails silently (pcall) when no parser exists for the current filetype.
vim.api.nvim_create_autocmd('FileType', {
  callback = function(ev)
    pcall(vim.treesitter.start, ev.buf)
  end,
})

-- Parsers that must be built and placed in the parser runtime directory.
-- Parsers already bundled with neovim (lua, markdown) are intentionally omitted.
local parsers = {
  { lang = 'html',       repo = 'https://github.com/tree-sitter/tree-sitter-html' },
  { lang = 'json',       repo = 'https://github.com/tree-sitter/tree-sitter-json' },
  { lang = 'javascript', repo = 'https://github.com/tree-sitter/tree-sitter-javascript' },
  { lang = 'typescript', repo = 'https://github.com/tree-sitter/tree-sitter-typescript', subdir = 'typescript' },
  { lang = 'css',        repo = 'https://github.com/tree-sitter/tree-sitter-css' },
  { lang = 'yaml',       repo = 'https://github.com/tree-sitter-grammars/tree-sitter-yaml' },
  { lang = 'dockerfile', repo = 'https://github.com/camdencheek/tree-sitter-dockerfile' },
}

-- Parsers live in site/parser/ which is already in neovim's runtimepath by default.
local parser_dir = vim.fn.stdpath('data') .. '/site/parser'
vim.fn.mkdir(parser_dir, 'p')

local function install_parser(info, force)
  -- Skip if the parser is already loadable, unless forcing an update.
  if not force and vim.treesitter.language.add(info.lang) then
    return
  end

  local parser_file = parser_dir .. '/' .. info.lang .. '.so'
  local tmp_dir = vim.fn.tempname()

  vim.system(
    { 'git', 'clone', '--depth=1', info.repo, tmp_dir },
    { text = true },
    function(clone_result)
      if clone_result.code ~= 0 then
        vim.schedule(function()
          vim.notify('treesitter: clone failed for ' .. info.lang, vim.log.levels.WARN)
        end)
        return
      end

      local build_path = info.subdir and (tmp_dir .. '/' .. info.subdir) or tmp_dir

      vim.system(
        { 'tree-sitter', 'build', '--output', parser_file, build_path },
        { text = true },
        function(build_result)
          vim.schedule(function()
            vim.fn.delete(tmp_dir, 'rf')
            if build_result.code ~= 0 then
              vim.notify('treesitter: build failed for ' .. info.lang, vim.log.levels.WARN)
            else
              vim.notify('treesitter: updated ' .. info.lang .. ' parser', vim.log.levels.INFO)
            end
          end)
        end
      )
    end
  )
end

local function check_cli()
  if vim.fn.exepath('tree-sitter') == '' then
    vim.notify(
      'treesitter: tree-sitter-cli not found in PATH — parser install/update skipped.',
      vim.log.levels.WARN
    )
    return false
  end
  return true
end

-- Install any missing parsers asynchronously after startup.
-- On subsequent launches this is a no-op (language.add guard above).
vim.defer_fn(function()
  if not check_cli() then return end
  for _, parser_info in ipairs(parsers) do
    install_parser(parser_info)
  end
end, 100)

-- :TSUpdate [lang]  — rebuild one or all managed parsers from source.
vim.api.nvim_create_user_command('TSUpdate', function(opts)
  if not check_cli() then return end
  local lang = opts.args ~= '' and opts.args or nil
  if lang then
    local info = vim.iter(parsers):find(function(p) return p.lang == lang end)
    if info then
      install_parser(info, true)
    else
      vim.notify('treesitter: unknown parser "' .. lang .. '"', vim.log.levels.WARN)
    end
  else
    for _, parser_info in ipairs(parsers) do
      install_parser(parser_info, true)
    end
  end
end, {
  nargs = '?',
  complete = function()
    return vim.tbl_map(function(p) return p.lang end, parsers)
  end,
})
