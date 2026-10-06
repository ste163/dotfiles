-- Image conversion for the native-image viewer: turns any supported image
-- file into PNG bytes for the backend.
--
-- Format paths:
--   png        -- readblob passthrough
--   jpg/jpeg/webp -- magick
--   gif        -- magick, first frame only (static)
--   svg        -- magick's built-in MSVG renderer first, rsvg-convert
--                 fallback (no delegates needed)
--   pdf        -- sips (macOS, no ghostscript) then pdftoppm (poppler),
--                 then magick/ghostscript
--
-- Converted bytes are cached in memory for the session, keyed by path +
-- mtime + density (density changes output for vector formats). Nothing is
-- ever written to disk.
--
-- This is the growth file: animated gif, multi-page pdf, and new formats
-- land here, isolated from the viewer UI.

local M = {}

-- In-memory conversion cache: path+mtime+density -> PNG bytes. Session-
-- scoped on purpose -- no cache directory to grow or clean up.
local mem_cache = {}

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

---Render PDF page 1 to PNG. macOS: sips does it natively, no ghostscript
---needed. Elsewhere: pdftoppm (poppler). Returns nil if neither works, so
---to_png() falls through to the magick/gs path. Temp files live under
---vim.fn.tempname() and are always cleaned up.
---@param path string
---@return string? data
local function pdf_to_png(path)
	if vim.fn.has("mac") == 1 and vim.fn.executable("sips") == 1 then
		local tmp = vim.fn.tempname() .. ".png"
		local res = vim.system({ "sips", "-s", "format", "png", "-Z", "1600", path, "--out", tmp }):wait()
		if res.code == 0 and vim.uv.fs_stat(tmp) then
			local data = vim.fn.readblob(tmp)
			vim.uv.fs_unlink(tmp)
			return data
		end
		vim.uv.fs_unlink(tmp)
	end

	if vim.fn.executable("pdftoppm") == 1 then
		local dir = vim.fn.tempname()
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
		vim.fn.delete(dir, "rf")
	end

	return nil
end

---Convert an image file to PNG bytes, caching the result in memory for
---the session.
---@param path string
---@return string? png_bytes
---@return string? err
function M.to_png(path)
	local ext = vim.fn.fnamemodify(path, ":e")
	if ext:lower() == "png" then
		local ok, data = pcall(vim.fn.readblob, path)
		if not ok then
			return nil, tostring(data)
		end
		return data
	end

	local key = cache_key(path, ext)
	if mem_cache[key] then
		return mem_cache[key]
	end

	-- PDF first: sips (macOS) or pdftoppm, both dependency-free paths.
	if ext:lower() == "pdf" then
		local data = pdf_to_png(path)
		if data then
			mem_cache[key] = data
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
				mem_cache[key] = res2.stdout
				return res2.stdout
			end
		end
		return nil, vim.trim(res.stderr or "magick failed")
	end

	local data = res.stdout
	if not data or #data == 0 then
		return nil, "magick produced no output"
	end

	mem_cache[key] = data
	return data
end

---Parse width and height from PNG header bytes (IHDR chunk).
---@param data string
---@return integer? width
---@return integer? height
function M.png_dims(data)
	if #data < 24 or data:sub(1, 8) ~= "\137PNG\r\n\26\n" then
		return nil
	end
	local b = string.byte
	local w = b(data, 17) * 16777216 + b(data, 18) * 65536 + b(data, 19) * 256 + b(data, 20)
	local h = b(data, 21) * 16777216 + b(data, 22) * 65536 + b(data, 23) * 256 + b(data, 24)
	return w, h
end

return M
