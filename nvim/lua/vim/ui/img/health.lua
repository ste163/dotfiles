-- Healthcheck for :checkhealth vim.ui.img.
--
-- Permanent while the native-image backend exists, for two reasons:
--   1. Some 0.13-dev nightly builds predate the healthcheck commit in core
--      and report "No healthcheck found".
--   2. Even once core ships its own, ours deliberately shadows it (the
--      config dir is earlier on runtimepath): core's version warns that tmux
--      "may not display correctly", which is wrong for this setup -- our
--      backend wraps passthrough itself. Ours reports through the overridden
--      backend, so the tmux verdict reflects the wrapper actually in use.
-- Delete this file if the backend override is ever removed.
local M = {}

function M.check()
	vim.health.start("vim.ui.img")

	if vim.env.TMUX then
		vim.health.ok("tmux detected - passthrough wrapping is handled by the native-image backend")
	else
		vim.health.info("not in tmux - raw kitty graphics sequences are sent directly")
	end

	local supported, msg = vim.ui.img._supported()
	if supported then
		vim.health.ok("kitty graphics protocol path available")
	else
		vim.health.error("images are not renderable: " .. tostring(msg), {
			"enable passthrough in ~/.tmux.conf:",
			"  set -gq allow-passthrough all",
			"then reload it with:",
			"  tmux source-file ~/.tmux.conf",
		})
	end
end

return M
