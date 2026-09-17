"""Copy this file to secrets.py on the Pico and fill in local credentials."""

WIFI_SSID = "your-wifi-network"
WIFI_PASSWORD = "your-wifi-password"
MABEL_URL = "http://your-mabel-host:8788/shyvers/start-normal"

# Used by the authenticated OTA endpoint and the raw GP16 relay test.
# Keep the filled-in values only in the ignored secrets.py on the Pico.
OTA_TOKEN = "choose-a-long-random-local-update-token"
RELAY_TEST_TOKEN = "choose-a-separate-local-relay-test-token"

# main.py also accepts the shorter SSID/PASSWORD names, but the WIFI_* names
# are preferred for clarity. Set MABEL_URL to the address of your own bridge.
# Never commit the filled-in secrets.py file.
