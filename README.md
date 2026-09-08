# Shyvers Multiphone Project

Historical reconstruction and reversible modernization of a Shyvers Multiphone.

This repository is the home for the Shyvers Multiphone/Mabel runtime, Mac
bridge, Harmony integration, Pico credit trigger, sounds, wiki, and rendered
project site.

## Project idea

The goal is not to turn the antique unit into a generic modern jukebox. The goal
is to recreate the service that originally existed at the other end of its wire:

```text
coin → Multiphone → Mabel → Now Playing → jukebox queue → MPD/moOde → speakers
```

The Multiphone remains the customer interface, the nickel starts the transaction,
Mabel acts as the central music operator, and the existing audio system provides
the program audio.

## A brief history

The Shyvers Multiphone was designed as a coin-operated telephone music selector.
Kenneth C. Shyvers' 1941 utility patent, US 2,264,911, describes a customer
station that accepted payment, connected the caller to a central operator, and
let the caller request a record from a catalog. The records were kept at a
central studio, so the Multiphone was a short, paid request call—not a local
jukebox operated directly by the customer.

Multiple stations could share a request line, while the requested music played
separately through the establishment's sound system. This project preserves
that division: the antique Multiphone is the customer interface, Mabel is the
operator, and Now Playing is the modern equivalent of the operator's queue and
record library.

Shyvers did not allow the lady operators to use their real names on the line.
Several chose the name Mabel, which is why this project uses Mabel for its
modern operator. See the [historical operating model](wiki/historical-operating-model.md)
for the source-backed details and modern mapping.

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

`operator/harmony_hub.mjs` is a generic local WebSocket client for a user's
Harmony Hub. It keeps a persistent connection, detects stale sockets with
ping/pong, reconnects after disconnects, and retries failed requests. It does
not assume a Denon receiver or ship a shared hub mapping. Generate your own
local mapping using [`config/README.md`](config/README.md).

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
and hub ID must come from the user's own Harmony configuration.

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
actually queue a selection. Set `NOW_PLAYING_MULTIPHONE_URL` to the API address
used by your installation.

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
existing Multiphone endpoint. OpenAI TTS provides the spoken prompt and
confirmation by default, with macOS `say` retained as a fallback. Use
`--tts macos --fallback-voice Samantha` to return to local speech.

The bridge listens on port `8788` and exposes `/shyvers/call`, `/shyvers/response`,
`/shyvers/offscript`, `/shyvers/speak`, `/shyvers/end`, and `/health`.

An iPad Shortcut can start a VIP/off-script Realtime call by POSTing to
`/shyvers/start` on the Mac, or a normal numbered call by POSTing to
`/shyvers/start-normal`. The bridge launches one Realtime process; a second
request while Mabel is active returns HTTP 409. Both endpoints use the
configured `--realtime-input` device (default `:0`), which currently maps to
the SSL 2 at AVFoundation device `:0`. The bridge LaunchAgent must run as an
interactive Aqua user-session process so endpoint-launched Realtime capture
receives the same Core Audio signal as the terminal flow.

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

## Mabel Realtime voice agent

### iPad handset prototype

The iPad can now be the actual Mabel handset: Safari supplies the microphone
and audio output, while the Mac keeps the permanent OpenAI key and proxies
music actions through the local bridge. Start the bridge first, then run the
HTTPS handset server:

```sh
python3 operator/mabel_service.py --voice nova
python3 operator/mabel_web.py
```

On the iPad, open `https://<Mac-LAN-IP>:8790/`, accept the local certificate
warning, and pair the Bose speaker and microphone to the iPad. **Call Mabel**
starts directly in VIP/off-script mode. **Call Normal Mabel** starts the regular
Multiphone numbered-selection flow for testing the 170-position playlist.
The VIP mode supports the bounded album, artist, playlist, mix, and now-playing
actions. The permanent API key never enters the browser; the Mac mints a
short-lived Realtime client secret instead.

The same page also has **Text Mabel**. It starts a separate VIP text session;
type messages in the chat panel and Mabel replies on-screen without requesting
microphone permission or playing voice audio. Text sessions use the same bounded
music tools and close after a successful album, artist, playlist, or mix action.

This is separate from the older Mac-audio Realtime command below. Use one
handset mode at a time so two Mabel sessions do not compete for the bridge.

For natural, low-latency conversation, use the Realtime agent instead of the
fixed recording-window prototype. With `mabel_service.py` running, start:

```sh
node operator/mabel_realtime.mjs --input :0
```

The SSL 2 microphone is currently `:0`. Realtime converts the capture stream to
mono 24 kHz PCM, streams it to OpenAI, and buffers Mabel's response audio for
playback through the Mac's default output. The current Realtime voice is `sage`; `--voice` on the bridge affects
fallback TTS, not Realtime. The model can only submit a validated number from 1
through 170 in normal mode. Stop with Ctrl-C.

The call also uses local effects in `sounds/`: `phone-ringback-answer-click.m4a`
plays before the greeting, `high-heels-walk-2s.m4a` plays only after Realtime
recognizes a valid numbered selection and before Mabel's response, and
`phone-hangup-click.m4a` plays when the call ends. Conversational and off-script
turns do not trigger the heels cue. Mabel's response waits until the effect is
finished. Effects are played with `afplay`, serialized with Mabel's voice audio,
and microphone input is suppressed while they play. Override the directory with
`--sounds-dir /path/to/sounds`.

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

During a Realtime call, explicitly say **“go off script”** or **“I’m a VIP”** to
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
numbered selection, Mabel announces the result, says a brief goodbye, and ends
the call. An explicit “play it now” request remains a separate action when
available; ordinary selections remain FIFO.

See [operations and testing](site/operations-and-testing.html) for Keychain,
audio-routing, deployment, and troubleshooting details.

## VIP mode and future automations

VIP mode is the expanded, session-scoped version of off-script mode. It is
currently used by the iPad voice and text handsets and enables the bounded
music actions described above. The next design step is a Mac-side VIP action
registry so Mabel can eventually coordinate named automations such as:

- lighting scenes;
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
