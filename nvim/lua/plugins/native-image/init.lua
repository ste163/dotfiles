-- Loader for the native-image plugin (see backend.lua and viewer.lua).
--
-- Order matters: the backend installs itself as vim.ui.img first; the
-- viewer consumes the public vim.ui.img API and must come second.
--
-- Lifetime notes:
--   backend.lua -- scaffolding: dies when core handles tmux passthrough
--     itself. Delete backend.lua and its require line; viewer.lua keeps
--     working against core's backend unchanged.
--   viewer.lua  -- the durable consumer of the API.
require("plugins.native-image.backend")
require("plugins.native-image.viewer")
