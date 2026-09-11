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
