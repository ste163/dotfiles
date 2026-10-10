-- Native image backend: replaces vim.ui.img with a tmux-passthrough-aware
-- implementation (requires 0.13-dev nightly).
--
-- Core's vim.ui.img sends raw kitty graphics APC sequences via nvim_ui_send
-- with no tmux passthrough wrapping, so tmux eats them while this pane is
-- not visible. This module replaces vim.ui.img with a backend that wraps
-- every payload in tmux's DCS passthrough envelope
-- (ESC Pmux; ESC <payload> ESC \) before sending.
--
-- This module is scaffolding with a known expiry: it dies the day core
-- handles passthrough itself (upstream floated nvim_ui_send as the home for
-- it). Delete this file and its require in init.lua; the viewer in
-- viewer.lua talks only to the public vim.ui.img API and keeps working
-- against core's backend unchanged.
--
-- Requires tmux >= 3.4 with `set -gq allow-passthrough all` in
-- ~/.tmux.conf -- "on" silently drops passthrough from invisible panes,
-- which is exactly what breaks image cleanup on window switches.
--
-- API contract (same as core, see :help vim.ui.img):
--   id = set(bytes, { row, col, width, height, zindex })
--   set(id, new_opts)  -- update an existing placement
--   get(id) -> opts    -- current opts of a placement
--   del(id)            -- del(math.huge) deletes everything
--
-- The API itself is EXPERIMENTAL (semantics not finalized, nightly-only
-- until 0.13). This file mirrors core's runtime/lua/vim/ui/img/_kitty.lua
-- sequence construction, so it tracks any API shifts by design.
--
-- PNG bytes only, same as core; conversion lives in convert.lua.

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

-- Maps user-facing placement id to internal tracking info.
---@type table<integer, { img_id: integer, opts: vim.ui.img.Opts }>
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

		state[placement_id] = { img_id = img_id, opts = vim.deepcopy(opts) }
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

return M
