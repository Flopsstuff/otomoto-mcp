# Installing otomoto-mcp with a coding agent

This page is written to be handed to an AI coding agent (Claude Code, Codex CLI, Gemini CLI,
Cursor or similar) so it can install the server and attach it to the user's MCP client on its
own. A person can follow it too.

To use it, give your agent a prompt like:

> Install the otomoto-mcp MCP server by following
> https://github.com/Flopsstuff/otomoto-mcp/blob/main/docs/install-with-an-agent.md

---

## Instructions for the agent

Work through the steps in order. Stop and ask the user whenever a step says so, or when
something does not match what is described here. Do not guess.

### 1. Check the prerequisites

```bash
node --version
npm --version
git --version
```

- `node` must be **20 or newer**. If it is missing or older, stop and tell the user; do not
  install or upgrade Node yourself.
- `npm` and `git` must be present.

### 2. Get the code

Ask the user where to put the project if they have not said; otherwise use a sensible folder
for source code in their home directory. Then:

```bash
git clone https://github.com/Flopsstuff/otomoto-mcp.git
cd otomoto-mcp
```

If the folder already exists and is a clone of this repository, `git pull` in it instead of
cloning again. If it exists and is something else, stop and ask.

### 3. Build

```bash
npm ci
npm run build
```

The build writes `dist/index.js`, the server's entry point. Record its **absolute path** (for
example with `pwd`); every client below needs the absolute path, never a relative one.

Optional checks, both offline:

```bash
npm test            # fixture-based, makes no network request
```

### 4. Find out which MCP client to attach it to

Ask the user which client they use, unless it is obvious (for example, you are Claude Code and
the user asked you to install it for yourself). If they use several, attach it to each one they
name.

The server is a local stdio process: the command is `node` and the only argument is the
absolute path to `dist/index.js`. It needs no API key and no environment variables.

### 5. Attach it

**Never overwrite an existing config file.** Read it first, add the `otomoto` entry next to
whatever is already there, and keep a copy of the original (for example
`<file>.bak-<date>`) before writing. If an entry named `otomoto` already exists, show it to the
user and ask before replacing it. Write valid JSON or TOML; re-read the file after writing.

Replace `/ABS/PATH/otomoto-mcp/dist/index.js` below with the real absolute path.

**Claude Code** - use its CLI rather than editing files:

```bash
claude mcp add --scope user otomoto -- node /ABS/PATH/otomoto-mcp/dist/index.js
claude mcp list
```

Use `--scope project` instead if the user wants it only for one project (that writes a
`.mcp.json` in that project).

**Claude Desktop** - edit `claude_desktop_config.json`:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

**Cursor** - edit `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` in one project.

**Gemini CLI** - edit `~/.gemini/settings.json` (all projects) or `.gemini/settings.json` in
one project.

All three use the same `mcpServers` block:

```json
{
  "mcpServers": {
    "otomoto": {
      "command": "node",
      "args": ["/ABS/PATH/otomoto-mcp/dist/index.js"]
    }
  }
}
```

**Codex CLI** - edit `~/.codex/config.toml` and add:

```toml
[mcp_servers.otomoto]
command = "node"
args = ["/ABS/PATH/otomoto-mcp/dist/index.js"]
```

**Any other client** - look up how it registers a local stdio MCP server and give it the
same command and argument. If you cannot find out, show the user the `mcpServers` block above
and ask them where it goes.

On Windows, write the path with forward slashes or escaped backslashes in JSON
(`C:/Users/me/otomoto-mcp/dist/index.js`).

### 6. Verify

1. Tell the user to restart the client (or reload its MCP servers), since most clients read
   their config only at start-up.
2. After the restart, call the `otomoto_filter_options` tool with no arguments. It answers from
   a table inside the repository and makes no request to Otomoto. A list of filters means the
   server is attached and working.
3. Only if the user wants a live check, run one small search with `otomoto_search`, for example
   `{"filters": {"make": "lexus", "model": "lc"}, "limit": 3}`. That makes one request to
   Otomoto.

If the tools do not appear, check the client's MCP log, that the path in the config is
absolute and points at an existing `dist/index.js`, and that `node --version` in the client's
environment is 20 or newer.

### 7. Report

Tell the user, briefly: where the project is, which client config you changed (and where the
backup is), and whether the verification call succeeded. Mention that `git pull && npm ci &&
npm run build` in the project folder updates it later, followed by a client restart.

### Things not to do

- Do not set environment variables in the config unless the user asks for one; the defaults
  are what the project intends. The available settings are in the README's "Configuration".
- Do not run the server by hand to "test" it outside a client - it speaks MCP over stdin/stdout
  and will just wait.
- Do not run searches in a loop or fetch many pages to check that it works. This is a tool for
  one person's searches; see "Fair use" in the README.
