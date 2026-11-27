# pi-nanogpt-metrics

A minimal [Pi](https://github.com/earendil-works/pi-coding-agent) extension that shows provider metrics — **balance, weekly/daily usage quotas, and the renewal/reset date** — as one extra status line. It only registers a status through Pi's public API, so it appears in the **official Pi status bar**, in **[pi-open-tui](https://www.npmjs.com/package/pi-open-tui)**'s footer (as a third row), and in any other UI plugin that renders extension statuses. It never patches or replaces the host UI.

Example status line (Italian):

```
NanoGPT · $9.82 · 0 NGPT · Sett. 60.0M/60.0M · Img 0/100 · rinn. 30 nov · tra 3g
```

- `NanoGPT` — provider name (accent color)
- `$9.82` — balance in USD (green, yellow below $5, red below $1)
- `0 NGPT` — balance in credits (unit configurable per provider)
- `Sett. 60.0M/60.0M` — weekly input tokens: used/total (yellow above 70% consumption, red above 90%)
- `Img 0/100` — daily images: used/total
- `rinn. 30 nov · tra 3g` — renewal date with relative countdown (yellow when the reset is a day away)

## Features

- Balance in USD and in provider credits, with low-balance coloring
- Weekly and daily input-token quotas, plus a daily image quota
- Renewal/reset date with a relative countdown (`tra 3g`, `domani`)
- Theme-aware colors: uses the active Pi theme's tokens, with standard ANSI fallback
- Multilingual status text: Italian and English built in, extra languages via simple YAML files
- Token resolution from stored config, environment variables, or the LiteLLM credential Pi already manages
- `/metrics` menu to refresh, manage the token, and switch language
- Hardened requests: HTTPS enforced, explicit host allow-list, no redirects, 8s timeout, 1 MB response cap

## Requirements

- Pi (`@earendil-works/pi-coding-agent`)
- Node.js 22+ (Pi loads TypeScript extensions natively)

## Install

From GitHub (public repo):

```sh
pi install git:github.com/gladenko/pi-nanogpt-metrics
```

From a local checkout:

```sh
pi install /path/to/pi-nanogpt-metrics
```

Then restart Pi. Verify with `pi list`; the status line appears on the next session start (or `/reload`).

## Quick start

1. Create `~/.pi/statusbar-config.json` pointing to a routes file:

   ```json
   {
     "nanogpt": {
       "routesFile": "~/.pi/status-bar.yaml",
       "refreshMinutes": 5
     }
   }
   ```

2. Create `~/.pi/status-bar.yaml` with at least one provider (this example uses the official NanoGPT API):

   ```yaml
   providers:
     nanogpt:
       match:
         prefixes: ["nanogpt/", "nano-gpt/"]
       balanceUnit: NGPT
       routes:
         balance:
           url: "https://api.nano-gpt.com/v1/balance"
           method: POST
           headers:
             Authorization: "Bearer ${NANOGPT_API_KEY}"
         usage:
           url: "https://api.nano-gpt.com/v1/usage"
           headers:
             Authorization: "Bearer ${NANOGPT_API_KEY}"
   ```

3. Restart Pi. The metrics line shows up wherever your UI renders extension statuses. Open `/metrics` for the management menu.

## Configuration file — `~/.pi/statusbar-config.json`

All settings live under the `nanogpt` key:

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `routesFile` | string | — | Path to the YAML routes file (`~` is expanded). Required for metrics to appear. |
| `refreshMinutes` | number | `5` | Refresh interval in minutes. Clamped to `1`–`60`. |
| `token` | string | — | Stored credential injected for `${VAR}` references. Written with file mode `0600` and never displayed. |
| `language` | string | `"it"` | Status/menu language. `it` and `en` are built in; other languages come from label files (see below). |

## Routes file

Each entry under `providers` describes one provider.

### Provider fields

| Field | Description |
| --- | --- |
| `match.prefixes` | Array of model-ID prefixes that map a selected model to this provider (e.g. `"nanogpt/"`). Longest prefix wins. |
| `match.modelsFrom` | Array of `"subscriptionModels"` / `"paidModels"`. If no prefix matches, the selected model is looked up inside the lists fetched from those routes. |
| `modelAliases` | Map of UI model name → upstream API model id, e.g. `{"NanoGPT Pro": "gpt-5-pro"}`. Keys are matched case-insensitively and must be unique. |
| `balanceUnit` | Unit label for the credit balance shown next to the USD amount (e.g. `NGPT`). |
| `displayName` | Custom label shown in the status line instead of the provider key. Built-in pretty names: `nanogpt` → `NanoGPT`, `openrouter` → `OpenRouter`. |

### Route fields

A route is one HTTP request. Providers can define any of: `balance`, `usage`, `subscriptionModels`, `paidModels`.

| Field | Description |
| --- | --- |
| `url` | Endpoint URL. HTTPS required (except `localhost`/`127.0.0.1`/`[::1]`); no credentials in the URL. |
| `method` | `GET` (default) or `POST`. POST bodies default to `{}` unless `body` is set. |
| `headers` | Header map. String values may reference environment variables as `${NAME}`. |
| `body` | JSON body. Same `${NAME}` expansion as headers. |
| `allowedHosts` | Explicit allow-list of hostnames for third-party HTTPS endpoints. Required for any host other than `api.nano-gpt.com`, `nano-gpt.com`, or localhost. |
| `response` | Map from normalized target field to a dot-separated path in the response (e.g. `{"usdBalance": "data.credits.usd"}`). Array indexes work: `items.0.amount`. |

### Response normalization

The extension looks for balance and usage values automatically, but you can override or map unusual responses with `response`:

- Balance fields: `usdBalance`, `nanoBalance`
- Usage fields: `weeklyInputTokens`, `dailyInputTokens`, `dailyImages`, `limits`, `period`

Each quota object uses `used` and/or `remaining`, plus an optional `resetAt` (renewal date). If the API returns `remaining` only, the used amount is computed when the total is known (`limits` or `used + remaining`).

## Credentials and `${VAR}` expansion

`${NAME}` references in `headers` and `body` resolve in this order:

1. **Stored token** — `nanogpt.token` in `~/.pi/statusbar-config.json`
2. **Process environment** — the named variable (e.g. `NANOGPT_API_KEY`)
3. **Stored LiteLLM credential** — the API key Pi already stores for the `litellm` provider in `~/.pi/agent/auth.json` (only real keys; helper commands prefixed `!` are not extracted)
4. **`LITELLM_API_KEY`** environment variable

Notes:

- Literal header values (no `${…}`) are sent unchanged.
- If no credential resolves, requests are skipped and the status line shows the "not available" label instead of failing silently with wrong data.
- The token value is never displayed in the status line, never logged, and the config file is written atomically with mode `0600`.
- A configured HTTPS host must appear in `allowedHosts` — no accidental exfiltration to unknown endpoints.

## The `/metrics` menu

| Item | Behavior |
| --- | --- |
| Refresh now / Aggiorna ora | Reloads the config and routes file, clears cached state, and fetches metrics immediately. |
| Set token… / Imposta token… | Prompts for a credential and stores it as `nanogpt.token` (file mode `0600`). The input is not masked — the value is briefly visible on screen. |
| Use LiteLLM key / Usa chiave LiteLLM | Copies the LiteLLM API key Pi already manages into the stored token. |
| Remove stored token / Rimuovi token salvato | Deletes the stored token. |
| Language… / Lingua… | Lists available languages (✓ marks the active one) and stores the choice. |
| Close / Chiudi | Exits the menu. |

## Status line anatomy and colors

Colors come from the active Pi theme (`theme.fg(token, text)`), falling back to standard ANSI codes when no theme is available:

| Element | Theme token | Fallback | Rule |
| --- | --- | --- | --- |
| Provider name | `accent` | bold | — |
| Balance | `success` / `warning` / `error` | green / yellow / red | Green; yellow below $5; red below $1. Route failure → red label. |
| Usage quotas | `success` / `warning` / `error` | green / yellow / red | Green below 70% consumption, yellow 70–90%, red above 90%. |
| Renewal date | `dim` or `warning` | dim / yellow | Yellow when the reset is a day away or less. |
| `uso n/d` / `usage n/a` | `warning` | yellow | Usage route rejected or credential missing. |
| Error messages | `error` | red | Config/routes problems. |
| `loading…` | `muted` | dim | First fetch pending. |

## Languages

Status text defaults to Italian. Pick a language in the menu (stored as `nanogpt.language`), or add languages by scanning: the extension looks for files named `status-bar-<lang>.yaml` (also `.yml`, e.g. `status-bar-fr.yaml`, `status-bar-de_DE.yaml`) in the routes-file directory (or `~/.pi` when no routes file is set).

```yaml
name: Français        # optional display name shown in the menu
labels:
  weekly: "Sem."
  daily: "Jour"
  renewal: "renouv."
  inDays: "dans {n}j" # {n} is replaced with the day count
```

Any built-in label can be overridden; unknown keys are ignored. Label files are re-scanned on every reload (startup, `/metrics` actions), so new languages appear without restarting Pi.

## Compatibility with other status bars

The extension publishes exactly one status (`pi-nanogpt-metrics`) through Pi's core `setStatus` API:

- **Official Pi UI** — extension statuses are part of the core status line; the metrics show up automatically.
- **pi-open-tui** — appears as a third footer row. Rendered by `footerSegments.extensionStatuses` (default `true`); disable it to hide the row.
- **Custom footers** — any widget/footer that renders extension statuses shows the line, with the extension's own styles preserved.
- **UIs that don't render statuses** — the extension stays harmless and invisible; nothing breaks.

No footer is replaced, patched, or rewritten — the extension only adds one line wherever the host UI chooses to render it.

## Development

```sh
npm install
npm run typecheck
```

Smoke-test that the module loads (no Pi required):

```sh
node --experimental-strip-types -e 'import("./index.ts").then(() => console.log("ok"))'
```

Project layout: `index.ts` (single-file extension), `package.json`, `README.md`.

To push updates to GitHub, switch `gh` to the owning account first (repo-local git config already uses it as author):

```sh
gh auth switch -u gladenko
git push
gh auth switch -u gianluca-rettore-unipd   # restore your previous account
```

## Support this project

If this extension is useful, consider signing up to NanoGPT with the author's referral link: you get **5% off eligible usage**, and it supports the maintenance of this project. The `/metrics` menu has a **Referral** item that opens the same link in your browser.

**[Sign up to NanoGPT](https://nano-gpt.com/r/fJzL4yYd)**

## Credits and license

Derived from the *pi-lightweight-status-bar* concept (status-line provider metrics for Pi), reduced to a single NanoGPT-focused status. MIT licensed — see [LICENSE](LICENSE).
