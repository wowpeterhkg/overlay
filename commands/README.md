# Claude Code slash commands

Drop these into `~/.claude/commands/` (user-level) or a project's `.claude/commands/` to get `/overlay-on` and `/overlay-off` in Claude Code.

- **`/overlay-on`** — spawn or reuse the bridge, then loop: read open tags → view each screenshot → fix the source in the current project → resolve (pin disappears in the browser) → watch for more.
- **`/overlay-off`** — stop the loop and, if this session started the bridge, stop it.

Both files reference the bridge entry point as `<overlay-repo>/packages/mcp-bridge/dist/cli.js`. Replace `<overlay-repo>` with the absolute path where you cloned this repo (and run `npm install && npm run build` there once). The commands are the on-demand alternative to registering the bridge as an MCP server — nothing loads unless you invoke `/overlay-on`.
