# Local installation configuration

This repository contains the public Mabel software. Installation-specific addresses, device IDs, credentials, certificates, and runtime state belong in local configuration and must not be committed.

## Pico endpoint and Wi-Fi

Copy micropicoMultiphone/secrets.example.py to micropicoMultiphone/secrets.py on the Pico and set the Wi-Fi values and local MABEL_URL. The filled-in secrets.py is ignored by Git.

## Harmony mapping

Export the local Harmony configuration and generate the local mapping files:

    node operator/harmony_config.mjs --input "/path/to/your-Harmony-config.md"

This generates config/harmony-mapping.json and config/harmony-mapping.md. Both are installation-specific and ignored by Git. The tracked harmony-mapping.example.json documents the expected structure without real installation identifiers.

Set HARMONY_HOST, HARMONY_PORT (usually 8088), HARMONY_DOMAIN (usually svcs.myharmony.com), HARMONY_HUB_ID, and HARMONY_VOLUME_DEVICE_ID for the local Harmony client.

The Mabel bridge and operator also accept installation-specific Now Playing and handset endpoints through command-line options or local LaunchAgent configuration. Keep those values out of committed source and documentation. On the current installation, the Mac bridge points at the Pi Now Playing API on port `3101`; the source default remains localhost so another installation can configure its own host.

## Live audio defaults

Normal Pico-triggered Live calls are configured in the bridge LaunchAgent with
these installation defaults:

- input: SSL 2 / AVFoundation `:0`;
- output: CoreAudio device `HIFI DSD`;
- playback: full duplex, stream mode, 1.0x local PCM speed;
- telephone EQ: 300–3400 Hz band-pass;
- voice gain: `1.78275`;
- master output gain: `+10 dB`.

The iPad browser Live path is separate: Safari owns its output and does not
route through the Mac's HIFI DSD device. Its secure Live relay listens on 8791
alongside the HTTPS handset on 8790.
