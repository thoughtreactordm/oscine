# Noctalia theme sync (Linux)

In **Settings → Theme → Color source**, choose **Noctalia desktop**, then **Set up**.
Setup detects which Noctalia is installed; if it cannot tell, pick **Quickshell v4** or
**Noctalia v5+** from the list beside the button.

- **Quickshell v4:** turn on **User templates** in Noctalia's **Settings → Color Scheme →
  Templates**, then change the color scheme once.
- **Noctalia v5+:** reload Noctalia's configuration, then apply a color scheme once.

The status moves from **Waiting for Noctalia** to **Synced with Noctalia** when the palette
arrives. After that, every scheme change in Noctalia repaints Oscine live, window background
included.

## What Noctalia colors, and what it doesn't

Noctalia supplies the neutral ramp and every surface, text and border token, plus secondary,
error and info (info comes from Material's `tertiary`). Success and warning keep the theme's
palettes.

**Primary is never taken from Noctalia.** The accent comes from where it always has: the
selected theme, your own `color.primary` override, or the cover art when **Reactive color** is
on. An override you set yourself still beats the cover art.

Both light and dark variants are exported. Oscine's **Mode** picks the variant; it does not
follow Noctalia's own light/dark toggle.

Noctalia's colors win over matching token overrides while sync is on. Fonts, shape and motion
overrides still apply. Switching back to **Oscine theme** restores your theme and overrides
untouched — sync never writes to `theme.overrides`, and an `.osctheme` export never carries the
desktop palette.

## Configuration

Setup writes `templates/oscine.json` under Noctalia's config directory. For v4 it appends
`[templates.oscine]` to `user-templates.toml`; for v5 it creates `oscine.toml` with
`[theme.templates.user.oscine]`.

The config directory is `$XDG_CONFIG_HOME/noctalia`, with `NOCTALIA_CONFIG_DIR` taking
precedence for v4 and `NOCTALIA_CONFIG_HOME` for v5. The v5 conflict check also reads the
GUI-managed `settings.toml` under `NOCTALIA_STATE_HOME` (or `$XDG_STATE_HOME/noctalia`).

The template renders to `$XDG_STATE_HOME/oscine/noctalia-palette.json` (default
`~/.local/state/oscine/`). Development and packaged builds share that path, so either can run
setup and both stay in sync.

Setup keeps other templates and comments, and can be run again. An `oscine` entry that points
at Oscine's template but exports elsewhere is repointed. Setup refuses to replace a hand-edited
template, an `oscine` entry Oscine did not create, a disabled entry, or a v5 `oscine` entry
declared in another file — fix the reported conflict and set up again. Nothing is executed:
no shell commands, no hooks. Startup never edits Noctalia's files; only **Set up** does.

## Recovery and removal

A bad or half-written palette keeps the last valid one for the session, with the error shown
under Color source. If none has loaded yet, the plain theme shows. Regenerate the palette in
Noctalia and use the retry button if needed.

Switching back to **Oscine theme** stops watching the file. To remove the export completely,
also delete the `oscine` template entry from Noctalia's configuration and its template file.
Turning sync off never edits Noctalia's files.

## References

- [Quickshell v4 user templates](https://docs.noctalia.dev/noctalia-shell-legacy/theming/user-templates/)
- [Noctalia v5 app theming](https://docs.noctalia.dev/noctalia/theming/app-theming/)
- [Noctalia v5 template reference](https://docs.noctalia.dev/noctalia/theming/templates/)

Ported from Kleron's implementation. A live smoke test against each shell version is still
needed.
