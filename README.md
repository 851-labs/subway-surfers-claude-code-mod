# Subway Surfers for Claude Code

A Claude Code mod that plays Subway Surfers gameplay in a side pane while Claude works, and pauses when it's your turn.

Inspired by [edwin's video-in-the-terminal mod](https://x.com/edwinarbus/status/2105869772219105325).

## Requirements

- A Claude Code build with function-hook mods (tested on 2.1.287; the API is early access)
- `ffmpeg` on the machine (`brew install ffmpeg`)
- Optional, for loading clips from a URL: `yt-dlp`, or `uv` so the mod can run the latest `yt-dlp` through `uvx`

## Install

```bash
git clone https://github.com/851-labs/subway-surfers-claude-code-mod
claude --plugin-dir ./subway-surfers-claude-code-mod
```

To load it in every session, including ones the desktop app starts, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/absolute/path/to/subway-surfers-claude-code-mod"
  }
}
```

## Use

The clip ships with the mod. On startup the mod cuts it into frames once (a few seconds, cached under `~/.cache/claude-subway-surfers/`). After that it plays whenever Claude is working and pauses when the turn ends, picking up where it left off.

| Command | What it does |
| --- | --- |
| `/brainrot` | Open the pane and play |
| `/brainrot <file or URL>` | Play another clip for this session |
| `/brainrot on` / `off` | Turn auto-play while Claude works on or off |
| `/brainrot sound` | Toggle the clip's audio (off by default) |
| `/brainrot stop` | Pause and close the pane |

In the pane, `p` plays or pauses and `m` toggles sound.

A pane that opens on its own needs a terminal at least 144 columns wide; narrower, it waits until you run `/brainrot`.

### Options

Set under `pluginConfigs.subway-surfers` in your settings, or from the config menu:

| Option | Default | |
| --- | --- | --- |
| `video` | built-in clip | Path or URL of a clip to play instead |
| `sound` | `false` | Play the clip's audio |
| `fps` | `12` | Frame rate the clip is decoded and played at |
| `autoplay` | `true` | Play while Claude works, pause when it finishes |

## How it works

`ffmpeg` decodes the clip to small PPM frames (at most 192 px on the longest side, first 3 minutes) and the audio to AAC, once per clip.

- **Terminal:** each frame is one `Raster`, a grid of `▀` cells whose foreground color is the top pixel and background the bottom one, repainted in place with `$.ui.blit`.
- **Desktop app:** each frame is drawn as an image in an `Svg`.

The code lives in [`hooks/register.tsx`](hooks/register.tsx) (events, `/brainrot`, the pane) and [`hooks/frames.ts`](hooks/frames.ts) (pixel helpers).

## License

The code is [MIT](LICENSE). The gameplay clip in `media/` is SYBO Games' and is not covered by that license; see [`media/NOTICE.md`](media/NOTICE.md).
