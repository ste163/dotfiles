-- Viewer layer of native-image: opens image files directly as rendered
-- images.
--
-- This is the durable part: a pure consumer of the public vim.ui.img API
-- (never the backend module's internals), so it survives the backend
-- override being deleted when core learns tmux passthrough.
--
-- BufReadCmd on image extensions intercepts the read entirely, so the
-- binary content is never loaded into the buffer or drawn to the screen
-- (a BufReadPre + schedule approach flashes one frame of binary garbage).
-- The buffer becomes a scratch display surface (nofile, nomodifiable, wipe
-- on close) and the image is rendered into the window via vim.ui.img.
-- Non-PNG formats go through convert.lua.

local convert = require("plugins.native-image.convert")

local viewer_group = vim.api.nvim_create_augroup("NativeImageViewer", { clear = true })

-- Image file patterns hijacked by BufReadCmd. Lowercase only: on macOS
-- 'fileignorecase' is on by default, so *.png also matches *.PNG -- and
-- listing both variants would make each pattern match twice per event,
-- firing setup() twice and orphaning a placement.
local EXTENSIONS = {
	"*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.svg", "*.pdf",
}

-- Terminal cell size in pixels, from TIOCGWINSZ via FFI ioctl. Ghostty
-- reports the true cell area (required for kitty-protocol terminals).
-- Falls back to the classic 2:1 ratio of 10x20 pixels.
local cell = nil ---@type {number, number}?

local function cell_size()
	if cell then
		return cell
	end
	local ok, ffi = pcall(require, "ffi")
	if ok then
		pcall(function()
			ffi.cdef([[
				typedef struct { unsigned short row; unsigned short col; unsigned short xpixel; unsigned short ypixel; } winsize;
				int ioctl(int, int, ...);
			]])
			local TIOCGWINSZ = vim.fn.has("mac") == 1 and 0x40087468 or 0x5413
			local sz = ffi.new("winsize")
			if ffi.C.ioctl(1, TIOCGWINSZ, sz) == 0 and sz.col > 0 and sz.row > 0 and sz.xpixel > 0 then
				cell = { sz.xpixel / sz.col, sz.ypixel / sz.row }
			end
		end)
	end
	cell = cell or { 10, 20 }
	return cell
end

---Fit an image into a window, centered. Width/height in cells; kitty
---letterboxes when both are given, so aspect ratio is preserved.
---@param win integer
---@param img_w integer
---@param img_h integer
---@return vim.ui.img.Opts opts
local function compute_opts(win, img_w, img_h)
	local cw, ch = unpack(cell_size())
	local win_w = vim.api.nvim_win_get_width(win)
	local win_h = vim.api.nvim_win_get_height(win)

	local avail_w = win_w * cw * 0.85
	local avail_h = win_h * ch * 0.85
	-- Fit within 85% of the window, allow upscaling up to 4x.
	local scale = math.min(avail_w / img_w, avail_h / img_h, 4)

	local cols = math.max(1, math.floor((img_w * scale) / cw + 0.5))
	local rows = math.max(1, math.floor((img_h * scale) / ch + 0.5))
	local col = math.max(1, math.floor((win_w - cols) / 2) + 1)
	local row = math.max(1, math.floor((win_h - rows) / 2) + 1)

	return { row = row, col = col, width = cols, height = rows }
end

---@type table<integer, { data: string, w: integer, h: integer }?> buffer -> image
local buf_state = {}

---@type table<integer, integer> buffer -> placement id
local placements = {}

---Convert window-relative fit (compute_opts) into absolute terminal-grid
---coordinates. vim.ui.img places at the terminal's real cursor position, so
---row/col must be absolute screen cells: the window's screen position plus
---the relative offset. Clamped to the terminal grid.
---@param win integer
---@param img_w integer
---@param img_h integer
---@return vim.ui.img.Opts opts
local function render_opts(win, img_w, img_h)
	local rel = compute_opts(win, img_w, img_h)
	local srow, scol = unpack(vim.fn.win_screenpos(win))

	local row = srow + rel.row - 1
	local col = scol + rel.col - 1

	return {
		row = row,
		col = col,
		width = math.min(rel.width, vim.o.columns - col + 1),
		height = math.min(rel.height, vim.o.lines - row + 1),
	}
end

---Delete every placement on the active screen. This plugin is the only
---producer of images in the terminal and at most one image buffer is
---visible at a time, so delete-all is always correct. It is also the only
---delete that clears placements a Ghostty window resize may have orphaned
---from image-id addressing (still drawn, no longer reachable via d=i).
local function clear_all()
	for buf in pairs(placements) do
		placements[buf] = nil
	end
	vim.ui.img.del(math.huge)
end

---(Re)render the image for a buffer whose window is visible.
---@param buf integer
local function render(buf)
	local st = buf_state[buf]
	if not st then
		return
	end
	local win = vim.fn.bufwinid(buf)
	if win == -1 then
		return
	end

	-- Always a fresh render: clear everything first (handles placements
	-- orphaned by terminal resizes), then transmit + place anew.
	clear_all()
	placements[buf] = vim.ui.img.set(st.data, render_opts(win, st.w, st.h))
end

---Remove everything without forgetting the buffer state, so the image can
---be re-rendered later.
local function hide()
	clear_all()
end

---Set up an image buffer (BufReadCmd path) as a rendered image view.
---@param buf integer
---@param path string
local function setup(buf, path)
	if not vim.api.nvim_buf_is_valid(buf) or buf_state[buf] then
		return
	end

	local data, err = convert.to_png(path)
	if not data then
		vim.notify("native-image: could not convert " .. path .. ": " .. tostring(err), vim.log.levels.ERROR)
		return
	end
	local w, h = convert.png_dims(data)
	if not w then
		vim.notify("native-image: not a valid PNG after conversion: " .. path, vim.log.levels.ERROR)
		return
	end

	-- Convert the buffer into a scratch display surface.
	vim.bo[buf].buftype = "nofile"
	vim.bo[buf].bufhidden = "wipe"
	vim.bo[buf].filetype = "image"
	vim.bo[buf].swapfile = false
	vim.bo[buf].modifiable = true
	vim.api.nvim_buf_set_lines(buf, 0, -1, false, {})
	vim.bo[buf].modifiable = false
	vim.bo[buf].modified = false

	buf_state[buf] = { data = data, w = w, h = h }

	-- Clean image view: no line numbers, no cursor line, no status column.
	local win = vim.api.nvim_get_current_win()
	vim.wo[win].number = false
	vim.wo[win].relativenumber = false
	vim.wo[win].cursorline = false
	vim.wo[win].statuscolumn = ""

	placements[buf] = vim.ui.img.set(data, render_opts(win, w, h))
end

-- Hijack image files with BufReadCmd: the default read never happens, so
-- the binary content is never loaded into the buffer or drawn to the screen
-- (a BufReadPre + schedule approach flashes one frame of binary garbage).
-- The buffer is set up synchronously and the image rendered instead. Only
-- the extensions above match; every other file takes the normal read path.
vim.api.nvim_create_autocmd("BufReadCmd", {
	group = viewer_group,
	pattern = EXTENSIONS,
	callback = function(ev)
		local path = ev.file and ev.file ~= "" and ev.file or vim.fn.expand("<afile>")
		setup(ev.buf, path)
	end,
})

-- Hide the placement when leaving an image buffer, re-render when
-- entering one. Prevents placements from stacking as files are opened
-- sequentially in the same window.
vim.api.nvim_create_autocmd("BufLeave", {
	group = viewer_group,
	callback = function(ev)
		if buf_state[ev.buf] then
			hide()
		end
	end,
})

vim.api.nvim_create_autocmd("BufEnter", {
	group = viewer_group,
	callback = function(ev)
		if buf_state[ev.buf] then
			render(ev.buf)
		end
	end,
})

-- Tmux (with focus-events on) sends FocusOut/FocusIn when the window or
-- pane loses/gains focus. Kitty placements persist in the terminal until
-- explicitly deleted, so without this they would bleed across tmux windows
-- and panes: delete everything on FocusLost, redraw on FocusGained.
vim.api.nvim_create_autocmd("FocusLost", {
	group = viewer_group,
	callback = function()
		clear_all()
	end,
})

vim.api.nvim_create_autocmd("FocusGained", {
	group = viewer_group,
	callback = function()
		local buf = vim.api.nvim_get_current_buf()
		if buf_state[buf] then
			render(buf)
		end
	end,
})

-- Placements live at the screen level in the terminal, so they bleed across
-- tmux windows. Focus events cannot be relied on (they need focus-reporting
-- terminfo capabilities that may be absent), so poll tmux directly for
-- whether this pane is the active one: hide everything when it is not,
-- re-render the current image buffer when it becomes active again. The
-- 300ms polling delay also ensures the delete lands after tmux has finished
-- its window-switch redraw.
local function tmux_pane_active()
	-- Must target THIS pane explicitly: without -t, display-message
	-- evaluates in the context of the currently focused pane, which after a
	-- window switch is the pane the user switched TO -- always active.
	local pane = vim.env.TMUX_PANE
	if not pane or pane == "" then
		return true -- no way to ask; assume visible
	end
	local res = vim.system({ "tmux", "display-message", "-p", "-t", pane, "#{pane_active}" }, { text = true }):wait()
	return res and res.code == 0 and vim.trim(res.stdout or "") == "1"
end

if vim.env.TMUX then
	local was_active ---@type boolean?
	local activity_timer = vim.uv.new_timer()
	activity_timer:start(300, 300, vim.schedule_wrap(function()
		local active = tmux_pane_active()
		if active == was_active then
			return
		end
		was_active = active
		if active then
			local buf = vim.api.nvim_get_current_buf()
			if buf_state[buf] then
				render(buf)
			end
		else
			clear_all()
		end
	end))
end

-- Close the image view with q.
vim.api.nvim_create_autocmd("FileType", {
	group = viewer_group,
	pattern = "image",
	callback = function(ev)
		vim.keymap.set("n", "q", function()
			vim.cmd("bdelete")
		end, { buffer = ev.buf, desc = "Close image view" })
	end,
})

-- Delete the placement when the image buffer is wiped (q, bdelete, exit).
vim.api.nvim_create_autocmd("BufWipeout", {
	group = viewer_group,
	callback = function(ev)
		clear_all()
		buf_state[ev.buf] = nil
	end,
})

-- Re-fit every visible image after terminal or window resizes. Debounced:
-- WinResized fires repeatedly while dragging splits.
local resize_timer ---@type uv_timer_t?

local function schedule_rerender()
	if resize_timer then
		return
	end
	resize_timer = vim.defer_fn(function()
		resize_timer = nil
		local current = vim.api.nvim_get_current_buf()
		for buf in pairs(buf_state) do
			local win = vim.fn.bufwinid(buf)
			if win ~= -1 and buf == current then
				render(buf)
			end
		end
	end, 50)
end

vim.api.nvim_create_autocmd({ "VimResized", "WinResized" }, {
	group = viewer_group,
	callback = schedule_rerender,
})

---Clear all image placements and forget image buffers.
vim.api.nvim_create_user_command("NativeImageClear", function()
	clear_all()
	buf_state = {}
end, { desc = "Clear all native-image placements" })
