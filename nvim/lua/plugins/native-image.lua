-- Native image rendering on top of the experimental vim.ui.img API
-- (requires 0.13-dev nightly).
--
-- Two layers with different lifetimes:
--
-- 1. Backend override (first half of this file): replaces vim.ui.img
--    because core sends raw kitty graphics APC sequences via nvim_ui_send
--    with no tmux passthrough wrapping, so tmux eats them while this pane
--    is not visible. This layer wraps every payload in tmux's DCS
--    passthrough envelope (ESC Pmux; ESC <payload> ESC \) before sending.
--    It is scaffolding with a known expiry: it dies the day core handles
--    passthrough itself (upstream floated nvim_ui_send as the home for it),
--    at which point the viewer below targets the core API directly.
--    Requires tmux >= 3.4 with `set -gq allow-passthrough all` in
--    ~/.tmux.conf -- "on" silently drops passthrough from invisible panes,
--    which is exactly what breaks image cleanup on window switches.
--
-- 2. Viewer layer (second half): opens image files as rendered buffers.
--    This is the durable part -- a consumer of the API with no known expiry.
--
-- The API itself is EXPERIMENTAL (semantics not finalized, nightly-only
-- until 0.13). Both layers may need updates if the API shifts before 0.13
-- stable; the override tracks the API by design.
--
-- API contract (same as core, see :help vim.ui.img):
--   id = set(bytes, { row, col, width, height, zindex })
--   set(id, new_opts)  -- update an existing placement
--   get(id) -> opts    -- current opts of a placement
--   del(id)            -- del(math.huge) deletes everything
--
-- PNG bytes only, same as core. Conversion of jpg/gif/webp/svg/pdf lives in
-- the viewer layer in the second half of this file.

local M = {}

local send_to_terminal = vim.api.nvim_ui_send

---Send a payload to the terminal, wrapping it in tmux's passthrough envelope
---when running inside tmux. Passthrough hands the bytes to the outer terminal
---(Ghostty) untouched, so the CSIs and APCs behave exactly as without tmux.
---@param payload string
local function send(payload)
	if vim.env.TMUX then
		payload = "\027Ptmux;\027" .. (payload:gsub("\027", "\027\027")) .. "\027\\"
	end
	send_to_terminal(payload)
end

-- Same id-generation scheme as core (mixes nvim's pid into the id space so
-- concurrent nvim instances do not collide on the terminal's global ids).
local generate_id = (function()
	local bit = require("bit")
	local NVIM_PID_BITS = 10

	local nvim_pid = 0
	local cnt = 30

	return function()
		if nvim_pid == 0 then
			local pid = vim.fn.getpid()
			nvim_pid = bit.band(bit.bxor(pid, bit.rshift(pid, 5), bit.rshift(pid, NVIM_PID_BITS)), 0x3FF)
		end
		cnt = cnt + 1
		return bit.bor(bit.lshift(nvim_pid, 24 - NVIM_PID_BITS), cnt)
	end
end)()

---Build a kitty graphics protocol escape sequence.
---@param control table<string, string|number>
---@param payload string?
---@return string
local function seq(control, payload)
	local parts = { "\027_G" }

	local tmp = {}
	for k, v in pairs(control) do
		tmp[#tmp + 1] = k .. "=" .. v
	end
	if #tmp > 0 then
		parts[#parts + 1] = table.concat(tmp, ",")
	end

	if payload and payload ~= "" then
		parts[#parts + 1] = ";"
		parts[#parts + 1] = payload
	end

	parts[#parts + 1] = "\027\\"
	return table.concat(parts)
end

---Transmit PNG bytes to the terminal in base64 chunks (direct transmission).
---q=2 suppresses kitty responses: inside tmux passthrough the response
---round-trip is unreliable, so we never ask for one.
---@param id integer kitty image id
---@param data string raw PNG bytes
local function transmit(id, data)
	local chunk_size = 4096
	local base64_data = vim.base64.encode(data)
	local pos = 1
	local len = #base64_data

	while pos <= len do
		local end_pos = math.min(pos + chunk_size - 1, len)
		local chunk = base64_data:sub(pos, end_pos)
		local is_last = end_pos >= len

		local control = {}
		if pos == 1 then
			control.f = "100" -- PNG format
			control.a = "t" -- transmit without displaying
			control.t = "d" -- direct transmission
			control.i = id
			control.q = "2" -- suppress responses
		end
		control.m = is_last and "0" or "1"

		send(seq(control, chunk))
		pos = end_pos + 1
	end
end

---Display a transmitted image at a cell position with cursor management.
---The whole cursor dance and the APC go out as one payload, so one passthrough
---envelope covers it.
---@param img_id integer
---@param placement_id integer
---@param opts vim.ui.img.Opts
local function place(img_id, placement_id, opts)
	local cursor_save = "\0277"
	local cursor_hide = "\027[?25l"
	local cursor_move = string.format("\027[%d;%dH", opts.row or 1, opts.col or 1)
	local cursor_restore = "\0278"
	local cursor_show = "\027[?25h"

	local control = {
		a = "p",
		i = img_id,
		p = placement_id,
		C = "1", -- do not move the cursor
		q = "2", -- suppress responses
	}
	if opts.width then
		control.c = opts.width
	end
	if opts.height then
		control.r = opts.height
	end
	if opts.zindex then
		control.z = opts.zindex
	end

	send(cursor_save .. cursor_hide .. cursor_move .. seq(control) .. cursor_restore .. cursor_show)
end

-- Maps user-facing placement id to internal tracking info. `data` is kept so
-- the viewer layer can re-render after a resize without re-reading the file.
---@type table<integer, { img_id: integer, opts: vim.ui.img.Opts, data: string }?>
local state = {}

---Display an image or update an existing one (same semantics as core).
---@param data_or_id string|integer image bytes (string) or existing id (integer)
---@param opts? vim.ui.img.Opts
---@return integer id
function M.set(data_or_id, opts)
	opts = opts or {}
	vim.validate("data_or_id", data_or_id, { "string", "number" })
	vim.validate("opts", opts, "table")

	if type(data_or_id) == "string" then
		local img_id = generate_id()
		local placement_id = generate_id()

		transmit(img_id, data_or_id)
		place(img_id, placement_id, opts)

		state[placement_id] = { img_id = img_id, opts = vim.deepcopy(opts), data = data_or_id }
		return placement_id
	end

	local id = data_or_id
	local entry = state[id]
	assert(entry, "invalid image id: " .. tostring(id))

	local merged = vim.tbl_extend("force", entry.opts, opts)
	place(entry.img_id, id, merged)
	entry.opts = merged
	return id
end

---Get the opts for an image.
---@param id integer
---@return vim.ui.img.Opts? opts
function M.get(id)
	vim.validate("id", id, "number")

	local entry = state[id]
	if not entry then
		return nil
	end
	return vim.deepcopy(entry.opts)
end

---Get the raw PNG bytes for a placement (viewer layer uses this for resizes).
---@param id integer
---@return string? data
function M.get_data(id)
	local entry = state[id]
	return entry and entry.data or nil
end

---Delete an image, or all images if math.huge is given as the id.
---@param id integer
---@return boolean found
function M.del(id)
	vim.validate("id", id, "number")

	if id == math.huge then
		local has_ids = next(state) ~= nil
		state = {}
		if has_ids then
			send(seq({ a = "d", d = "A", q = "2" }))
		end
		return has_ids
	end

	local entry = state[id]
	if not entry then
		return false
	end

	-- Uppercase I: delete the image AND free its data. Lowercase would keep
	-- the data alive (for potential re-display) even though we re-transmit
	-- on every render -- over many resize cycles that accumulates images in
	-- the terminal until its quota/eviction logic kicks in and deletes for
	-- evicted ids become no-ops, leaving stale placements on screen.
	send(seq({ a = "d", d = "I", i = entry.img_id, q = "2" }))
	state[id] = nil
	return true
end

---@private
---Query whether the host terminal can display images.
---Outside tmux, delegate to core's real terminal query. Inside tmux the
---query/response round-trip cannot survive passthrough, so check tmux's
---passthrough option instead and assume the outer terminal speaks the kitty
---protocol (Ghostty does).
---@param opts? {timeout?: integer}
---@return boolean supported
---@return string? msg
function M._supported(opts)
	if not vim.env.TMUX then
		return require("vim.ui.img._kitty").supported(opts)
	end

	local res = vim.system({ "tmux", "show-options", "-gv", "allow-passthrough" }, { text = true }):wait()
	if not res or res.code ~= 0 then
		return false, "tmux query failed"
	end

	local val = vim.trim(res.stdout or "")
	if val == "on" or val == "all" then
		return true
	end
	return false, "tmux allow-passthrough is " .. (val == "" and "unset" or val)
end

-- Clear every placement when nvim exits, like core does.
vim.api.nvim_create_autocmd("VimLeavePre", {
	callback = function()
		M.del(math.huge)
	end,
})

-- Replace core's backend with this one. Any consumer of vim.ui.img
-- (including :checkhealth vim.ui.img) now routes through the passthrough
-- wrapper.
vim.ui.img = M

-- ===========================================================================
-- Viewer layer: open image files directly as rendered images
-- ===========================================================================
--
-- BufReadPre on image extensions converts the buffer into a scratch display
-- surface (nofile, nomodifiable, wipe on close) and renders the image into
-- the window via the backend above. Non-PNG formats are converted through
-- ImageMagick and cached under stdpath("cache")/native-image/.

local viewer_group = vim.api.nvim_create_augroup("NativeImageViewer", { clear = true })

local cache_dir = vim.fn.stdpath("cache") .. "/native-image"
vim.fn.mkdir(cache_dir, "p")

-- Image file patterns hijacked by BufReadPre. Lowercase only: on macOS
-- 'fileignorecase' is on by default, so *.png also matches *.PNG -- and
-- listing both variants would make each pattern match twice per event,
-- firing setup() twice and orphaning a placement.
local EXTENSIONS = {
	"*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.svg", "*.pdf",
}

-- ImageMagick args per format. PNG passes through untouched.
local function conversion_args(path, ext)
	ext = ext:lower()
	if ext == "gif" then
		return { path .. "[0]", "png:-" } -- first frame only, static
	elseif ext == "svg" then
		-- magick's internal SVG renderer (MSVG) needs no delegate; -depth 8
		-- keeps the output 8-bit instead of 16-bit
		return { "-density", "192", "-background", "none", "-depth", "8", path, "png:-" }
	elseif ext == "pdf" then
		-- reading PDFs requires the ghostscript delegate; on macOS sips is
		-- tried first in to_png() so this path only runs where gs exists
		return { "-density", "192", path .. "[0]", "-background", "white", "-alpha", "remove", "-depth", "8", "png:-" }
	end
	return { path, "png:-" }
end

-- Cache key: path + mtime + density (density changes output for vector formats).
local function cache_key(path, ext)
	local stat = vim.uv.fs_stat(path)
	local mtime = stat and (stat.mtime.sec + stat.mtime.nsec / 1e9) or 0
	local extra = (ext:lower() == "svg" or ext:lower() == "pdf") and "d192" or ""
	return vim.fn.sha256(path .. ":" .. mtime .. ":" .. extra)
end

---@param cache_file string
---@param data string
local function write_cache(cache_file, data)
	local f = io.open(cache_file, "wb")
	if f then
		f:write(data)
		f:close()
	end
end

---Render PDF page 1 to PNG. macOS: sips does it natively, no ghostscript
---needed. Elsewhere: pdftoppm (poppler). Returns nil if neither works, so
---to_png() falls through to the magick/gs path.
---@param path string
---@param cache_file string
---@return string? data
local function pdf_to_png(path, cache_file)
	if vim.fn.has("mac") == 1 and vim.fn.executable("sips") == 1 then
		local tmp = cache_file .. ".tmp.png"
		local res = vim.system({ "sips", "-s", "format", "png", "-Z", "1600", path, "--out", tmp }):wait()
		if res.code == 0 and vim.uv.fs_stat(tmp) then
			local data = vim.fn.readblob(tmp)
			vim.uv.fs_unlink(tmp)
			return data
		end
	end

	if vim.fn.executable("pdftoppm") == 1 then
		local dir = cache_file .. ".d"
		vim.fn.mkdir(dir, "p")
		local res = vim.system({ "pdftoppm", "-f", "1", "-l", "1", "-png", "-r", "192", path, dir .. "/page" }):wait()
		if res.code == 0 then
			local out = dir .. "/page-1.png"
			if vim.uv.fs_stat(out) then
				local data = vim.fn.readblob(out)
				vim.fn.delete(dir, "rf")
				return data
			end
		end
	end

	return nil
end

---Convert an image file to PNG bytes, caching the result on disk.
---@param path string
---@return string? png_bytes
---@return string? err
local function to_png(path)
	local ext = vim.fn.fnamemodify(path, ":e")
	if ext:lower() == "png" then
		local ok, data = pcall(vim.fn.readblob, path)
		if not ok then
			return nil, tostring(data)
		end
		return data
	end

	local key = cache_key(path, ext)
	local cache_file = cache_dir .. "/" .. key .. ".png"
	if vim.uv.fs_stat(cache_file) then
		local ok, data = pcall(vim.fn.readblob, cache_file)
		if ok then
			return data
		end
	end

	-- PDF first: sips (macOS) or pdftoppm, both dependency-free paths.
	if ext:lower() == "pdf" then
		local data = pdf_to_png(path, cache_file)
		if data then
			write_cache(cache_file, data)
			return data
		end
	end

	local args = { "magick" }
	vim.list_extend(args, conversion_args(path, ext))
	local res = vim.system(args, { stdout = true, stderr = true }):wait()
	if res.code ~= 0 then
		-- svg: retry with rsvg-convert when magick's renderer fails
		if ext:lower() == "svg" and vim.fn.executable("rsvg-convert") == 1 then
			local res2 = vim.system({ "rsvg-convert", "-w", "1600", "-b", "none", path }, { stdout = true, stderr = true }):wait()
			if res2.code == 0 and res2.stdout and #res2.stdout > 0 then
				write_cache(cache_file, res2.stdout)
				return res2.stdout
			end
		end
		return nil, vim.trim(res.stderr or "magick failed")
	end

	local data = res.stdout
	if not data or #data == 0 then
		return nil, "magick produced no output"
	end

	write_cache(cache_file, data)
	return data
end

---Parse width and height from PNG header bytes (IHDR chunk).
---@param data string
---@return integer? width
---@return integer? height
local function png_dims(data)
	if #data < 24 or data:sub(1, 8) ~= "\137PNG\r\n\26\n" then
		return nil
	end
	local b = string.byte
	local w = b(data, 17) * 16777216 + b(data, 18) * 65536 + b(data, 19) * 256 + b(data, 20)
	local h = b(data, 21) * 16777216 + b(data, 22) * 65536 + b(data, 23) * 256 + b(data, 24)
	return w, h
end

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

---Delete every placement on the active screen. This module is the only
---producer of images in the terminal and at most one image buffer is
---visible at a time, so delete-all is always correct. It is also the only
---delete that clears placements a Ghostty window resize may have orphaned
---from image-id addressing (still drawn, no longer reachable via d=i).
local function clear_all()
	for buf in pairs(placements) do
		placements[buf] = nil
	end
	M.del(math.huge)
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
	placements[buf] = M.set(st.data, render_opts(win, st.w, st.h))
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

	local data, err = to_png(path)
	if not data then
		vim.notify("native-image: could not convert " .. path .. ": " .. tostring(err), vim.log.levels.ERROR)
		return
	end
	local w, h = png_dims(data)
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

	placements[buf] = M.set(data, render_opts(win, w, h))
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

return M
