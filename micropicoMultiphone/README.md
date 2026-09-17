# Multiphone Pico trigger

`main.py` runs on the Pico 2 W, watches the optocoupler on GP15, and POSTs
to the Mac's Normal Mabel endpoint when a credit is detected.

Copy `secrets.example.py` to `secrets.py` on the Pico and fill in
`WIFI_SSID` and `WIFI_PASSWORD`. The filled-in `secrets.py` is intentionally
excluded from this repository. Keep it on the device only and never commit
credentials.

The status page is served on port 80. The Mabel endpoint is configured locally
as `MABEL_URL` in `secrets.py`; do not hard-code an installation address in
tracked source. The normal endpoint is the Mac bridge's
`/shyvers/start-normal` route, which starts GPT-Live with the installation's
HIFI DSD, telephone EQ, full-duplex, and gain defaults. A new credit replaces
any older bridge-managed call.

## Confirmed Multiphone shoe wiring

The original numbered shoe has separate circuits:

* Pins 6–7 are the normally-open dime-switch circuit. Female shoe pin 6 is
  black and pin 7 is red. The firmware detects the isolated optocoupler output
  on GP15, which remains active-low.
* Pins 8–9 are the original jewel-lamp circuit. The socket center contact is
  pin 8 and the threaded shell is pin 9.

The 5V lamp supply is wired through the GP16 relay: 5V+ to relay COM, relay NO
to shoe pin 8, and shoe pin 9 to 5V−. The installed Songle SRD-03VDC-SL-C
module is confirmed active-high: GP16 level 1 energizes the relay and turns
the jewel on; level 0 turns it off. Relay VCC and the optocoupler VCC share the
Pico's 3V3 output, with a common Pico ground.

## GP16 jewel relay

The installed relay module has been physically verified as active-high:
GP16 level 1 energizes the relay and turns the jewel lamp on; level 0 turns it
off. Production firmware drives GP16 LOW/OFF before Wi-Fi startup.

Set `RELAY_TEST_TOKEN` in the Pico's ignored `secrets.py`, then use:

```text
POST http://<pico-ip>/relay/test?level=0
POST http://<pico-ip>/relay/test?level=1
GET  http://<pico-ip>/relay/status
Authorization: Bearer <RELAY_TEST_TOKEN>
```

`/relay/status` reports the raw GP16 level, interpreted `ON`/`OFF` state, pin
mode, and whether automatic control is enabled. The raw test endpoint remains
available for diagnostics. The logical endpoints used by the Mac bridge are:

```text
POST http://<pico-ip>/relay/on
POST http://<pico-ip>/relay/off
Authorization: Bearer <RELAY_TEST_TOKEN>
```

After GP15 has passed its debounce interval, a valid dime trigger turns the
jewel on before the bridge request. A failed bridge request turns it back off.
The Mac bridge turns it off when the Mabel client process ends.

`/relay/status` includes the redacted Mabel destination as `mabelTarget` so a
Pico network problem can be distinguished from an HTTP failure. An
OTA-token-authenticated `POST /config/mabel-url` with the plain-text bridge URL
can repair the device-local destination without changing `secrets.py` or the
firmware's pin behavior.

## Authenticated OTA

The Pico also supports the Mills-style authenticated local-LAN OTA endpoint:

```text
POST http://<pico-ip>/ota
Authorization: Bearer <OTA_TOKEN>
```

Uploads are limited to 64 KiB, staged as `main.new.py`, syntax-checked before
installation, and retained with the previous program as `main.backup.py`.
The first installation must be performed over USB/serial because the current
firmware does not yet contain the OTA endpoint. After that, run
`../deploy-pico.sh` from this project with an explicit `PICO_IP`. The deploy
script verifies `/relay/status` after reboot.

On every boot, GP15 remains disarmed until it has been continuously inactive
for the startup qualification interval. This prevents a held or noisy dime
input during boot or an OTA reboot from starting a Mabel call.
