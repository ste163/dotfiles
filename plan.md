# Plan: wire codebase-memory-mcp into pi via pi-mcp-adapter

Goal: pi (via already-installed `pi-mcp-adapter`) can call codebase-memory-mcp
tools (search_graph, trace_path, get_code_snippet, query_graph, search_code,
index_repository). Binary already installed at `/Users/sam/.local/bin/codebase-memory-mcp`
(currently only wired into Codex's `~/.codex/config.toml`). No pi-side MCP
config file exists yet (`.mcp.json`, `.pi/mcp.json`, `~/.config/mcp/mcp.json`
all absent).

1. Create `dotfiles/.pi/mcp.json` (new file, follows same item-level-symlink
   pattern as `settings.json`/`keybindings.json`) with:
   ```json
   {
     "mcpServers": {
       "codebase-memory-mcp": {
         "command": "codebase-memory-mcp",
         "lifecycle": "lazy"
       }
     }
   }
   ```
   Use bare command name (relies on `~/.local/bin` already on PATH) so it
   stays portable across machines that install this dotfiles repo, rather
   than hardcoding `/Users/sam/.local/bin/...`.

2. Edit `dotfiles/install.sh`: add `"mcp.json:file"` to the `PI_ITEMS` array
   so it gets symlinked to `~/.pi/agent/mcp.json` (pi global override file,
   2nd in adapter's precedence order) alongside the existing items.

3. Run `./install.sh` to create the symlink and verify it in the script's
   own check output.

4. Restart pi (or run `/mcp reconnect codebase-memory-mcp`) and confirm via
   `/mcp` panel or `mcp({ server: "codebase-memory-mcp" })` that the server
   connects and lists its tools.

5. Optional: mention the new MCP server in `dotfiles/README.md` so it's
   documented alongside the other synced config.

No changes needed to `pi-mcp-adapter` itself (already installed via
`.pi/npm/node_modules/pi-mcp-adapter`, listed in `settings.json` packages).
