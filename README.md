# glm-router

A small local proxy that lets [Claude Code](https://docs.claude.com/en/docs/claude-code) use z.ai's GLM models alongside Anthropic's Claude models, with one command: `claude-glm`.

- `glm-*` model requests go to z.ai's Anthropic-compatible endpoint.
- Every other request (Opus, Sonnet, Haiku) goes to Anthropic unchanged, with your own credentials.
- It uses only Node's standard library. There are no dependencies to install.

## Why this exists

Claude Code sends every request to `ANTHROPIC_BASE_URL`. Pointing that variable at z.ai in your global settings would send Claude models there too. It also turns off features that Claude Code only enables for `api.anthropic.com`, including Remote Control, `/feedback`, the Opus advisor tool and optimistic tool search.

This project avoids that. Only the `claude-glm` process uses the router. Plain `claude` still talks to Anthropic directly.

## How it works

```
claude-glm ──► 127.0.0.1:18787 (router.js)
                 ├─ model starts with "glm-" ──► https://api.z.ai/api/anthropic
                 └─ anything else            ──► https://api.anthropic.com
```

- `claude-glm` checks the router's `/healthz` endpoint. If the router is down, it exits with a hint.
- It runs `claude --settings claude-glm.settings.json`, which adds two rows to `/model`:
  - **GLM-5.3 (Pro)** → `glm-5.3`
  - **GLM-5.3 Flash** → `glm-5.3-flash`
- It sets `ENABLE_TOOL_SEARCH=true`, because Claude Code turns tool search off for any non-Anthropic base URL.
- A trailing `[1m]` on a model name is stripped before the request goes to z.ai.

### Security

The router holds your z.ai key, so it refuses requests that a web page could send:

- Any request with an `Origin` header gets **403**. Browsers add this header to cross-origin requests. Claude Code's own requests don't carry one.
- A `Host` header other than `127.0.0.1`, `localhost` or `[::1]` gets **403**. This blocks DNS-rebinding attacks.
- The router listens on `127.0.0.1` only.

## Requirements

- Claude Code (tested with 2.1.296).
- Node.js 18 or later (tested with 22).
- Linux with systemd and a user session, for the optional service. Without systemd, run `router.js` yourself (see below).
- A z.ai API key with GLM access.
- An Anthropic login, as usual for Claude Code.

## Install

1. **Clone the repo** into the location the scripts expect:

   ```bash
   git clone https://github.com/markkirby125/glm-router.git ~/.claude/glm-router
   ```

2. **Store your z.ai key** in a file readable only by you:

   ```bash
   mkdir -p ~/.config/glm-router
   chmod 700 ~/.config/glm-router
   umask 077
   printf '%s' 'YOUR_ZAI_API_KEY' > ~/.config/glm-router/zai.key
   chmod 600 ~/.config/glm-router/zai.key
   ```

   You can instead set `GLM_ROUTER_ZAI_KEY` in the service environment. The file is the safer option.

3. **Install the `claude-glm` wrapper** somewhere on your `PATH`:

   ```bash
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/claude-glm <<'EOF'
   #!/usr/bin/env bash
   # Claude Code with the z.ai GLM models added to /model.
   set -euo pipefail

   ROUTER=http://127.0.0.1:18787
   SETTINGS="$HOME/.claude/glm-router/claude-glm.settings.json"

   if ! curl -fsS -m 2 "$ROUTER/healthz" >/dev/null 2>&1; then
     echo "claude-glm: glm-router is not answering at $ROUTER" >&2
     echo "  start it with: systemctl --user start glm-router.service" >&2
     exit 1
   fi

   export ANTHROPIC_BASE_URL="$ROUTER"
   export ENABLE_TOOL_SEARCH=true

   exec claude --settings "$SETTINGS" "$@"
   EOF
   chmod +x ~/.local/bin/claude-glm
   ```

4. **Run the router as a systemd user service.** The unit below uses the output of `command -v node` and your home directory:

   ```bash
   mkdir -p ~/.config/systemd/user
   cat > ~/.config/systemd/user/glm-router.service <<EOF
   [Unit]
   Description=Local Claude Code router: glm-* models to z.ai, all others to Anthropic

   [Service]
   ExecStart=$(command -v node) $HOME/.claude/glm-router/router.js
   Environment=GLM_ROUTER_PORT=18787
   Restart=always
   RestartSec=2

   [Install]
   WantedBy=default.target
   EOF
   systemctl --user daemon-reload
   systemctl --user enable --now glm-router.service
   ```

5. **Check that it's running:**

   ```bash
   curl -s http://127.0.0.1:18787/healthz   # prints: ok
   ```

Without systemd, start the router in a separate terminal and leave it running:

```bash
node ~/.claude/glm-router/router.js
```

## Use

```bash
claude-glm
```

Then type `/model`. The two GLM rows appear with Opus, Sonnet and Haiku. Plain `claude` does not show them.

Inside `claude-glm`, Opus, Sonnet and Haiku still work, but these are unavailable:

- Remote Control and `/feedback`, which Claude Code disables for a custom base URL.
- The Opus advisor tool, and one plugin that needs it.

Use plain `claude` when you need those.

## Configuration

Environment variables for `router.js`:

| Variable | Default | Purpose |
|---|---|---|
| `GLM_ROUTER_PORT` | `18787` | Local port |
| `GLM_ROUTER_HOST` | `127.0.0.1` | Bind address. Keep this as loopback. |
| `GLM_ROUTER_ZAI_URL` | `https://api.z.ai/api/anthropic` | z.ai endpoint |
| `GLM_ROUTER_ANTHROPIC_URL` | `https://api.anthropic.com` | Anthropic endpoint |
| `GLM_ROUTER_ZAI_KEY` | none | z.ai key, if you don't use the key file |
| `GLM_ROUTER_ZAI_KEY_FILE` | `~/.config/glm-router/zai.key` | Path to the key file |

To change the GLM models shown in `/model`, edit `modelPicker` in `claude-glm.settings.json`. Each row needs `model`, `label`, `description` and `behavesAs`. `behavesAs` names a Claude model whose handling the GLM model should copy. It doesn't change the model ID that is sent.

After any change to `router.js`, restart the service:

```bash
systemctl --user restart glm-router.service
```

## Tests

```bash
node --test ~/.claude/glm-router/test/router.test.js
```

The 13 unit tests use local fake upstreams. They make no network calls and cost nothing. They cover routing, header handling, streaming, upstream failure, missing keys and the Origin/Host guard.

`live-check.sh` makes real `claude -p` calls, which cost money. It checks that:

1. Plain `claude` answers and sends nothing through the router.
2. `claude-glm` answers `OK` for `haiku`, `sonnet`, `opus`, `glm-5.3` and `glm-5.3-flash`.

```bash
bash ~/.claude/glm-router/live-check.sh </dev/null
```

A model passes only if its whole reply, trimmed, is exactly `OK`.

## Troubleshooting

| Symptom | Check |
|---|---|
| `claude-glm: glm-router is not answering` | `systemctl --user status glm-router` and `journalctl --user -u glm-router -n 50` |
| GLM model returns 401 | The key file is missing or empty. The router logs `no z.ai key configured`. |
| GLM model returns 502 | z.ai is unreachable. Check the network and `GLM_ROUTER_ZAI_URL`. |
| Rows missing from `/model` | You're in plain `claude`. Start `claude-glm`. |
| Model not accepted | Use `glm-5.3` or `glm-5.3-flash`, the IDs in the picker. |
| Service fails to start | The `ExecStart` paths to `node` or `router.js` are wrong. Run `command -v node` and check the unit file. |

To test the Origin guard by hand, this should print `403`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Origin: https://example.com' http://127.0.0.1:18787/v1/messages -d '{}'
```

## Limitations

- Routing is by model name only. The router reads the model field and strips a trailing `[1m]`, and leaves the rest of the request alone.
- It adds one local hop. It doesn't cache or retry.
- Only z.ai's Anthropic-compatible endpoint is supported.
- Features that need `api.anthropic.com` are off in `claude-glm`. The router can't turn them back on.
- z.ai's model names and pricing change. Check z.ai's documentation before relying on them.

## Uninstall

```bash
systemctl --user disable --now glm-router.service
rm ~/.config/systemd/user/glm-router.service ~/.local/bin/claude-glm
rm -r ~/.claude/glm-router ~/.config/glm-router
systemctl --user daemon-reload
```

## Licence

Released under the [MIT License](LICENSE). Copyright (c) 2026 Paul Kirby.
