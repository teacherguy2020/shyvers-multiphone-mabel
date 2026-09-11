# Shyvers Multiphone Project

## Related project

Shyvers Multiplayer has its own repository:

<https://github.com/teacherguy2020/shyvers-multiphone-mabel>

Keep Multiplayer-specific source and deployment files there. This project
contains the Multiphone/Mabel runtime, Mac bridge, and Pico credit trigger.

Historical reconstruction and reversible modernization of a Shyvers Multiphone.

## Project idea

The goal is not to turn the antique unit into a generic modern jukebox. The goal
is to recreate the service that originally existed at the other end of its wire:

```text
coin → Multiphone → Mabel → Now Playing → jukebox queue → MPD/moOde → speakers
```

The Multiphone remains the customer interface, the nickel starts the transaction,
Mabel acts as the central music operator, and the existing audio system provides
the program audio.

## Wiki

The editable Markdown source is in [`wiki/`](./wiki/). The browsable HTML version
is in [`site/`](./site/index.html).

The site is served alongside the Seeburg wiki by the shared LAN wiki server.
Start or restart that server with:

```sh
python3 /path/to/seeburg-wallbox/web/wiki-server.py
```

Then open `http://<Mac-LAN-IP>:8765/multiphone/` from a browser on the Mac or
an iPad on the same local network. The Seeburg wiki remains at
`http://<Mac-LAN-IP>:8765/wiki/`.

## Harmony Hub control

`operator/harmony_hub.mjs` is a generic local WebSocket client for the Harmony
Hub. It keeps a persistent connection, detects stale sockets with
ping/pong, reconnects after disconnects, and retries failed requests. It does
not assume a Denon receiver; device and activity names come from the generated
mapping files:

- `config/harmony-mapping.md` — local human-readable names, IDs, and exact command strings;
- `config/harmony-mapping.json` — local machine-readable mapping;
- [`config/harmony-mapping.example.json`](config/harmony-mapping.example.json) — sanitized public structure.

Examples:

```sh
# Send a discrete press by numeric ID and exact Harmony command.
node operator/harmony_hub.mjs command \
  --device-id YOUR_DEVICE_ID --command InputPhono --status press

# Send a release when implementing a press/release hold sequence.
node operator/harmony_hub.mjs command \
  --device-id YOUR_DEVICE_ID --command InputPhono --status release

# Resolve names through the persistent mapping.
node operator/harmony_hub.mjs command-by-name \
  --device "Denon AV Receiver" --command InputAux1
node operator/harmony_hub.mjs activity-by-name --activity "Network Music"

# Read the current live Harmony configuration (read-only).
node operator/harmony_hub.mjs config
```

The parser can be rerun when a fresh Harmony configuration dump is available:

```sh
node operator/harmony_config.mjs --input "/path/to/Harmony config.md"
```

The runtime exports `harmony_command(device_id, command, status)`,
`harmony_press_many(device_id, command, count)`,
`harmony_start_activity(activity_id)`, `harmony_get_config()`, and name-based
variants for use by other local Node tools. The WebSocket host, port, domain,
and hub ID come from the user's local Harmony configuration.

Terminal Mabel uses `harmony_press_many()` to lower the Denon by 40
`VolumeDown` presses rapidly during a call and restores the successfully sent presses
with matching `VolumeUp` presses four seconds after her final wrap-up begins. Override with
`--duck-steps N`, or disable for a test with `--duck-steps 0`. Ducking defaults to a
zero-delay burst; use `--duck-inter-press-ms N` to add spacing. Fade-up restoration
defaults to 5 ms between presses and can be adjusted independently with
`--restore-inter-press-ms N`.

## Keyboard prototype

The first Mac-side operator prototype submits a number to the live API:

```sh
python3 operator/main.py --number 1 --dry-run
```

The prototype reads the track key from macOS Keychain first. Set it up once with:

```sh
python3 operator/main.py --setup-keychain
```

macOS will prompt securely; the key is not included in the command or process
arguments. The Keychain item is stored under the service `Shyvers Multiphone /
Now Playing` for account `multiphone-operator`. `NOW_PLAYING_TRACK_KEY` remains
available as a fallback for existing protected local setups. Do not place the
key in this project, shell history, or command examples.

Omit `--number` for an interactive loop. Omit `--dry-run` only when ready to
actually queue a selection. Set `NOW_PLAYING_MULTIPHONE_URL` to the API address used by your installation.

## Mabel local bridge

Run the local Mac service in one Terminal window:

```sh
python3 operator/mabel_service.py --voice nova
```

It listens on port `8788`, starts a session when it receives
`POST /shyvers/call`, and handles a number at `POST /shyvers/response`. For a
keyboard-driven end-to-end test, use a second Terminal window:

```sh
python3 operator/mabel_console.py
```

The service retrieves the Now Playing key from macOS Keychain and uses the
existing Multiphone endpoint. Legacy bridge callers can use OpenAI TTS, with
macOS `say` retained as a fallback. During an active GPT-Live call, the bridge
returns structured authoritative results with `suppressSpeech`; GPT-Live/Sage
is the only conversational Mabel voice. Local phone, ambience, and footsteps
effects remain local.

The bridge listens on port `8788` and exposes `/shyvers/call`, `/shyvers/response`,
`/shyvers/offscript`, `/shyvers/speak`, `/shyvers/end`, and `/health`.

An iPad Shortcut or the Pico can start a normal GPT-Live call by POSTing to
`/shyvers/start-normal`. The bridge replaces any previous bridge-managed call
before launching the new one. The normal Live defaults are full duplex, stream
playback at 1.0x, Sage voice gain `1.78275`, +10 dB master gain, telephone EQ,
and the `HIFI DSD` output device. Both the Live and legacy Realtime clients use
the configured `--realtime-input` device (default `:0`), currently the SSL 2.
The bridge LaunchAgent must run as an interactive Aqua user-session process so
endpoint-launched capture receives the same Core Audio signal as the terminal
flow.

## Mabel fixed-window microphone fallback

The built-in Mac microphone can be tested with the voice prototype. First
store the separate OpenAI API key in macOS Keychain:

```sh
python3 operator/mabel_voice.py --setup-openai-key
```

With `mabel_service.py` running, start a voice test:

```sh
python3 operator/mabel_voice.py
```

The voice test uses a three-second default capture window and a bounded
conversation model. It retries transient AVFoundation failures, accepts spoken
numbers 1 through 170, and gives one retry prompt when it does not understand.
Use `--seconds 5` for a longer capture or `--turns 1` for a single-turn test.

## Mabel Live and Realtime voice agents

### GPT-Live terminal and Pico path

The current preferred Mac/Pico path is the GPT-Live/Sage client. Run this as
one shell command when testing from a terminal:

```sh
node operator/mabel_live.mjs --duplex full --playback-mode stream --voice-speed 1.0 --gain 1.78275 --master-gain-db 10 --telephone-eq --output-device "HIFI DSD" --input :0
```

The Live client keeps number validation, confirmation, catalog facts, credits,
queue state, Now Playing actions, and termination deterministic through the
bridge. The bridge's structured result is fed back into the active Live
session; local bridge TTS is suppressed, so GPT-Live/Sage is the only source of
Mabel's spoken conversational voice. Ringback, office ambience, heels, and the
hang-up click remain local effects. Live uses a native PCM player with a 1.5
second startup FIFO, adaptive refill, 300–3400 Hz telephone EQ, and explicit
CoreAudio routing to HIFI DSD. The `--gain` value affects Mabel's voice; the
master gain affects the complete Live output bus.

The Pico's normal trigger uses the same settings through
`POST /shyvers/start-normal`. A new trigger terminates a previous bridge-managed
call before starting the replacement. If output or capture wiring is changed,
verify the running child command in `~/Library/Logs/mabel-service.log`.

### iPad Live handset

The iPad can now be the actual Mabel handset: Safari supplies the microphone
and audio output, while the Mac keeps the permanent OpenAI key and proxies
music actions through the local bridge. Start the bridge first, then run the
HTTPS handset server:

```sh
python3 operator/mabel_service.py --voice nova
python3 operator/mabel_web.py
```

On the iPad, open `https://<Mac-LAN-IP>:8790/` and accept the local certificate
warning. **Call Normal Mabel** is the browser GPT-Live path for numbered
Multiphone calls. It uses the secure browser-to-Mac relay on port `8791`; the
Mac keeps the permanent OpenAI key and forwards the Live session upstream.
Safari plays the returned audio through the iPad's selected output, not the
Mac's HIFI DSD. **Call Mabel** remains the legacy browser WebRTC Realtime/VIP
path. **Text Mabel** remains the separate VIP text session.

In either Live path, say **“go off-script”** or **“I'm a VIP”** to enter the
bounded private music service. Album, artist, playlist, mix, and now-playing
requests are sent to the bridge; GPT-Live speaks only the authoritative result.

The same page also has **Text Mabel**. It starts a separate VIP text session;
type messages in the chat panel and Mabel replies on-screen without requesting
microphone permission or playing voice audio. Text sessions use the same bounded
music tools and close after a successful album, artist, playlist, or mix action.

Use one handset mode at a time so two Mabel sessions do not compete for the
bridge. The bridge will replace an older bridge-managed call if a new trigger
arrives.

### Legacy Realtime agent

For the unchanged production/legacy path, use the Realtime agent with
`mabel_service.py` running:

```sh
node operator/mabel_realtime.mjs --input :0
```

The SSL 2 microphone is currently `:0`. Realtime converts the capture stream to
mono 24 kHz PCM, streams it to OpenAI, and buffers Mabel's response audio for
playback through the Mac's default output. The current Realtime voice is `sage`; `--voice` on the bridge affects
fallback TTS, not Realtime. The model can only submit a validated number from 1
through 170 in normal mode. Stop with Ctrl-C.

The legacy call uses the same local assets in `sounds/`, but its audio behavior
and routing remain unchanged. Do not use this path to test the GPT-Live relay
or Live-specific HIFI DSD routing.

Mabel's generated responses intentionally have no artificial output-token cap:
small caps previously truncated otherwise complete audio. Cost is controlled by
local number/confirmation state, suppressed microphone input during playback,
local effects, concise stable instructions, and prompt termination after the
record result.

After each reply, Mabel waits for another caller utterance. After 15 seconds of
silence she exits without a spoken goodbye; `--idle-seconds 20` changes that
window. If the caller says goodbye, she replies in kind and exits immediately.
The eventual Pico/light controller can watch the clean session exit or the
`/shyvers/end` lifecycle to release the Shyvers indicators.

When a numbered selection joins records already waiting, Mabel gives the desk
announcement with the approximate number of spins ahead, then ends that
call after speaking. A new coin starts the next session.

For records that start immediately, Mabel uses varied approved wording such as
“It's playing now,” “It's spinning now,” or “I just dropped the needle on it.”
The service result remains authoritative; only the phrasing varies.

### Off-script mode

During a Live or Realtime call, explicitly say **“go off script”** or **“I’m a VIP”** to
unlock a bounded set of the existing Alexa-style music actions. Saying **“off
script”** anywhere
in an utterance unlocks the mode deterministically. Mabel acknowledges the
secret arrangement (for example, “Uh-huh… but don't tell Shyvers!”) and can then
play an album, shuffle an artist (capped at 50 tracks), play a saved playlist,
build a multi-artist mix, or report what is playing. These actions are routed
through the local Mabel bridge to existing Now Playing endpoints; the model does
not receive unrestricted HTTP access. Numeric Multiphone requests continue to
use the dedicated jukebox flow.

If no number is recognized, Mabel gives a short retry prompt. After a successful
numbered selection, Mabel announces the bridge-supplied result, says a brief
goodbye, and ends the call. Live VIP actions are bounded to album, artist,
playlist, mix, and now-playing requests; the model never receives unrestricted
HTTP or shell access.

See [operations and testing](site/operations-and-testing.html) for Keychain,
audio-routing, deployment, and troubleshooting details.

## VIP mode and future automations

VIP mode is the expanded, session-scoped version of off-script mode. It is
currently used by the iPad voice and text handsets and enables the bounded
music actions described above. The next design step is a Mac-side VIP action
registry so Mabel can eventually coordinate named automations such as:

- lighting scenes for Clem's Place or the listening room;
- Harmony Hub activities;
- audio/display ambience;
- future room-specific devices and cleanup actions.

These integrations are planned, not yet implemented. Each should be exposed as
a named, validated action or scene rather than unrestricted endpoint access.
The Mac should remain the credential and orchestration boundary; the iPad and
the model should receive only the minimum action/result data needed for the
active session. VIP start remains LAN-only and must not be port-forwarded.

## Current status

- A Shyvers Multiphone has been purchased and is awaiting delivery.
- Initial development can proceed with keyboard-simulated coin events.
- No antique hardware should be connected to mains power before documentation
  and electrical inspection.
- Hardware assumptions remain hypotheses until the machine is examined.

## Source note

The initial wiki synthesis is based on Brian's Apple Notes entry **“Shyvers
Multiphone Project”** in the `Jarvis` folder, captured September 2026. Historical
claims should be verified against patents, photographs, service documentation,
and the arriving machine.
