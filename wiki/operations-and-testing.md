# Operations and testing

## Project layout

```text
Multiphone/
├── operator/
│   ├── main.py              # keyboard numbered-selection client
│   ├── mabel_console.py     # keyboard conversation driver
│   ├── mabel_service.py     # local HTTP/session/TTS bridge
│   ├── mabel_voice.py       # fixed-window microphone fallback
│   ├── mabel_realtime.mjs   # unchanged legacy Realtime agent
│   ├── mabel_live.mjs       # preferred GPT-Live/Sage agent
│   ├── mabel_live_player.swift # native Live PCM/FIFO player
│   ├── mabel_live_web.mjs   # secure iPad Live relay
│   └── harmony_volume.mjs   # bridge-owned Denon duck/restore helper
├── sounds/                  # local call and record-retrieval effects
├── wiki/                    # editable Markdown source
├── site/                    # generated HTML
└── web/
    ├── build-wiki.py
    └── wiki-server.py
```

## Keychain credentials

There are two separate credentials:

| Credential | Keychain service | Account | Used by |
| --- | --- | --- | --- |
| Now Playing track key | `Shyvers Multiphone / Now Playing` | `multiphone-operator` | `main.py`, `mabel_service.py` |
| OpenAI API key | `Shyvers Multiphone / OpenAI` | `mabel-voice` | `mabel_voice.py`, Realtime client |

Set them up with the corresponding `--setup-keychain` or
`--setup-openai-key` command. Keys must not be placed in source files, URLs, or
command examples.

## Safe test sequence

From the project directory:

```sh
cd /path/to/shyvers-multiphone-mabel
python3 operator/main.py --number 1 --dry-run
```

For a real numbered selection, omit `--dry-run`. For a keyboard loop, omit
`--number`.

For the preferred local Mabel bridge and GPT-Live voice agent, use two terminals:

```sh
# Terminal 1
python3 operator/mabel_service.py --voice nova

# Terminal 2 — keep this one line intact
node operator/mabel_live.mjs --duplex full --playback-mode stream --voice-speed 1.0 --gain 1.78275 --master-gain-db 10 --telephone-eq --output-device "HIFI DSD" --input :0
```

The SSL 2 is currently input `:0`. Confirm available AVFoundation devices with:

```sh
ffmpeg -hide_banner -f avfoundation -list_devices true -i ""
```

Live call effects are stored locally as:

```text
sounds/
├── phone-ringback-answer-click.m4a
├── high-heels-walk-2s.m4a
└── phone-hangup-click.m4a
```

They are routed to the configured Live output device (`HIFI DSD` on the current
installation). Mabel's microphone input is suppressed while an effect or
response is playing. The heels effect is triggered after Mabel's brief
retrieval acknowledgment for a valid numbered selection; it is not played for
conversational or off-script turns. Playback does not begin until the effect is
done. If the files are stored elsewhere, add
`--sounds-dir /path/to/sounds` to the Live command.

The `mabel_voice.py` fallback can be tested with `--seconds 5` when a longer
capture window is needed.

## Audio routing

The SSL 2 is the current microphone interface at `:0`. The preferred Live
command applies the telephone band-pass in the native player and routes voice
and effects to CoreAudio device `HIFI DSD`; SoundSource is not required. Keep
the microphone input pointed at the SSL 2 and avoid routing Mabel's output back
into that input. The native Live FIFO starts with 1.5 seconds of PCM and can
adapt upward when Live delivery arrives in bursts.

The browser Live path is different: Safari plays audio through the iPad's
selected output. It uses the Mac HTTPS handset on port `8790` and secure Live
relay on `8791`; it cannot route the iPad speaker through the Mac's HIFI DSD.
The normal Pico path uses the Mac bridge and HIFI DSD defaults.

Use one-line commands for manual tests. Splitting a command across lines while
omitting an option can silently disable telephone EQ, output selection, or
master gain. Verify the startup log includes `telephoneEq: true`,
`outputDevice: HIFI DSD`, and the expected `masterGainDb`.

## Now Playing deployment

The Now Playing API is deployed at the installation's configured host on port
`3101`; it controls the configured MPD/moOode host. Set the API address for your
installation before running the operator. Changes to the Now Playing routes require
restarting the managed `now-playing.service` and verifying that exactly one
current process owns port 3101.

An orphaned old process once held the port while systemd repeatedly restarted the
service. The resulting symptoms included stale route behavior, wrong queue heads,
and apparent queue overflows. When behavior contradicts the deployed source,
check service status, process start time/restart count, listener ownership, and
the actual configured MPD host before changing queue logic.

An alert-only health watcher now checks service status, port ownership, listener
PID, and restart churn every 15 minutes. It does not auto-restart the service or
interrupt playback.

## VIP and off-script testing

VIP mode currently means expanded Mabel music controls from the iPad voice/text
handset and Live calls. Say “go off-script” or “I'm a VIP” during a Live call,
then request an album, artist, playlist, mix, or now-playing result. The bridge
executes only bounded actions and returns authoritative results to GPT-Live;
lighting scenes, Harmony Hub activities, and other room automation are future
integrations. When implemented, test each as a named action with:

1. a validated allow-listed action name;
2. an explicit target/argument schema;
3. a bounded timeout and useful result;
4. a defined cleanup or restore behavior when the session ends.

Keep these actions on the Mac-side bridge. Do not send device credentials to
the iPad or expose the VIP start endpoint beyond the trusted LAN.

## Documentation build

Edit Markdown under `wiki/`, then regenerate the HTML site:

```sh
python3 web/build-wiki.py
python3 -m py_compile web/build-wiki.py web/wiki-server.py operator/*.py
node --check operator/mabel_realtime.mjs
node --check operator/mabel_live.mjs
node --check operator/mabel_live_web.mjs
node --check operator/harmony_volume.mjs
```

The shared LAN wiki server serves this project at:

```text
http://<Mac-LAN-IP>:8765/multiphone/
```

The Seeburg wiki remains at `/wiki/` on the same server.

_Last updated: 2026-09-11_
