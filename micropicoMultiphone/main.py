# main.py
# Shyvers Multiphone -> Pico 2 W -> Mabel
# Adds a tiny status webpage, authenticated OTA, and GP16 relay test controls.

import gc
import machine
import os
import time
import network
import socket
from machine import Pin
import secrets

try:
    import ujson as json
except ImportError:
    import json

OPTO_PIN = 15
ACTIVE_LOW = True
ACTIVE_DEBOUNCE_MS = 100
REARM_MS = 500
POLL_MS = 10
HTTP_PORT = 80
RELAY_PIN = 16
RELAY_TEST_PATH = "/relay/test"
RELAY_STATUS_PATH = "/relay/status"
RELAY_ON_PATH = "/relay/on"
RELAY_OFF_PATH = "/relay/off"
OTA_PATH = "/ota"
MABEL_CONFIG_PATH = "/config/mabel-url"
OTA_TEMP_FILE = "main.new.py"
OTA_BACKUP_FILE = "main.backup.py"
MABEL_URL_FILE = "mabel_url.txt"
OTA_MAX_BYTES = 64 * 1024
STARTUP_ARM_MS = 1000
MABEL_TIMEOUT_S = 8

# The relay was physically verified as active-high: 1 energizes the relay.
RELAY_ON_LEVEL = 1
RELAY_OFF_LEVEL = 0
RELAY_AUTOMATION_ENABLED = True

boot_ms = time.ticks_ms()
trigger_count = 0
last_trigger_ms = None
last_post_status = "Never"
last_post_ok = None
armed = False
startup_ready = False
relay = None
relay_mode = "output"
last_relay_test = "not used"
ota_reboot_pending = False
last_ota_status = "not used"


def get_secret(*names):
    for name in names:
        if hasattr(secrets, name):
            return getattr(secrets, name)
    return None


SSID = get_secret("SSID", "WIFI_SSID", "ssid", "wifi_ssid")
PASSWORD = get_secret("PASSWORD", "WIFI_PASSWORD", "password", "wifi_password")
OTA_TOKEN = get_secret("OTA_TOKEN", "ota_token")
RELAY_TEST_TOKEN = get_secret(
    "RELAY_TEST_TOKEN", "relay_test_token", "OTA_TOKEN", "ota_token")


def configured_mabel_url():
    try:
        with open(MABEL_URL_FILE, "r") as config_file:
            value = config_file.read().strip()
            if value:
                return value
    except OSError:
        pass
    return get_secret("MABEL_URL", "MABEL_ENDPOINT", "mabel_url", "mabel_endpoint")


MABEL_URL = configured_mabel_url()

if not SSID or PASSWORD is None:
    raise RuntimeError("secrets.py must define WIFI_SSID/WIFI_PASSWORD")
if not MABEL_URL:
    raise RuntimeError("secrets.py must define MABEL_URL")


def connect_wifi():
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)

    if wlan.isconnected():
        print("Wi-Fi already connected:", wlan.ifconfig()[0])
        return wlan

    while not wlan.isconnected():
        print("Connecting to Wi-Fi:", SSID)
        wlan.connect(SSID, PASSWORD)
        started = time.ticks_ms()

        while not wlan.isconnected():
            status = wlan.status()
            if status < 0:
                print("Wi-Fi failed, status =", status)
                break
            if time.ticks_diff(time.ticks_ms(), started) > 30000:
                print("Wi-Fi timeout, status =", status)
                break
            time.sleep_ms(500)

        if not wlan.isconnected():
            try:
                wlan.disconnect()
            except Exception:
                pass
            print("Retrying Wi-Fi in 3 seconds...")
            time.sleep(3)

    print("Wi-Fi connected:", wlan.ifconfig()[0])
    return wlan


opto = Pin(OPTO_PIN, Pin.IN, Pin.PULL_UP)
# Drive the verified OFF level before Wi-Fi or HTTP startup.
relay = Pin(RELAY_PIN, Pin.OUT, value=RELAY_OFF_LEVEL)


def relay_raw_level():
    try:
        return relay.value()
    except Exception:
        return None


def relay_status_payload():
    raw_level = relay_raw_level()
    if relay_mode == "output" and raw_level in (0, 1):
        interpreted_state = "ON" if raw_level == RELAY_ON_LEVEL else "OFF"
    else:
        interpreted_state = "unknown"
    try:
        mabel_host, mabel_port, mabel_path = parse_http_url(MABEL_URL)
        mabel_target = "{}:{}{}".format(mabel_host, mabel_port, mabel_path)
    except Exception:
        mabel_target = "invalid MABEL_URL"
    return {
        "ok": True,
        "pin": RELAY_PIN,
        "rawLevel": raw_level,
        "mode": relay_mode,
        "interpretedState": interpreted_state,
        "polarity": "active-high",
        "automaticControl": RELAY_AUTOMATION_ENABLED,
        "lastTest": last_relay_test,
        "mabelTarget": mabel_target,
    }


def set_relay_test_level(level):
    global relay, relay_mode, last_relay_test
    if level not in (0, 1):
        raise ValueError("level must be 0 or 1")
    relay = Pin(RELAY_PIN, Pin.OUT, value=level)
    relay_mode = "output"
    last_relay_test = "raw level {}".format(level)
    print("Relay test level set: GP{} = {}".format(RELAY_PIN, level))


def set_relay_automatic(on):
    if not RELAY_AUTOMATION_ENABLED:
        return
    level = RELAY_ON_LEVEL if on else RELAY_OFF_LEVEL
    set_relay_test_level(level)


def relay_on():
    set_relay_automatic(True)


def relay_off():
    set_relay_automatic(False)


def opto_active():
    v = opto.value()
    return v == 0 if ACTIVE_LOW else v == 1


def parse_http_url(url):
    text = str(url).strip()
    if not text.startswith("http://"):
        raise ValueError("MABEL_URL must use http://")

    authority_and_path = text[7:]
    slash = authority_and_path.find("/")
    if slash < 0:
        authority = authority_and_path
        path = "/"
    else:
        authority = authority_and_path[:slash]
        path = authority_and_path[slash:] or "/"
    if not authority:
        raise ValueError("MABEL_URL host is missing")

    if ":" in authority:
        host, port_text = authority.rsplit(":", 1)
        port = int(port_text)
    else:
        host = authority
        port = 80
    if not host or port < 1 or port > 65535:
        raise ValueError("invalid MABEL_URL host or port")
    return host, port, path


def post_mabel_start():
    """Send the trigger with a bounded socket and inspect only its status line."""
    global last_post_status, last_post_ok
    client = None
    started = time.ticks_ms()
    try:
        host, port, path = parse_http_url(MABEL_URL)
        address = socket.getaddrinfo(host, port)[0][-1]
        client = socket.socket()
        client.settimeout(MABEL_TIMEOUT_S)
        client.connect(address)

        body = b"{}"
        host_header = host if port == 80 else "{}:{}".format(host, port)
        request = (
            "POST {} HTTP/1.1\r\n"
            "Host: {}\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: {}\r\n"
            "Connection: close\r\n\r\n"
        ).format(path, host_header, len(body)).encode() + body
        send_all(client, request)

        response = b""
        while b"\r\n" not in response and len(response) < 512:
            chunk = client.recv(128)
            if not chunk:
                break
            response += chunk
        line = response.split(b"\r\n", 1)[0].decode().split()
        if len(line) < 2 or not line[1].isdigit():
            raise OSError("Mabel returned no valid HTTP status")

        status_code = int(line[1])
        elapsed_ms = time.ticks_diff(time.ticks_ms(), started)
        last_post_status = "HTTP {} ({} ms)".format(status_code, elapsed_ms)
        last_post_ok = 200 <= status_code < 300
        print("Mabel POST status: {} ({} ms)".format(status_code, elapsed_ms))
        return last_post_ok
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass


def start_normal_mabel():
    global trigger_count, last_trigger_ms, last_post_status, last_post_ok
    trigger_count += 1
    last_trigger_ms = time.ticks_ms()
    print("Optocoupler active -> starting Normal Mabel")
    relay_on()

    try:
        last_post_ok = post_mabel_start()
        if not last_post_ok:
            relay_off()
        return last_post_ok
    except Exception as exc:
        last_post_status = "ERROR: {}".format(exc)
        last_post_ok = False
        print("POST failed:", exc)
        relay_off()
        return False


def uptime_text():
    s = time.ticks_diff(time.ticks_ms(), boot_ms) // 1000
    d, s = divmod(s, 86400)
    h, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    if d:
        return "{}d {:02}:{:02}:{:02}".format(d, h, m, s)
    return "{:02}:{:02}:{:02}".format(h, m, s)


def last_trigger_text():
    if last_trigger_ms is None:
        return "Never"
    age = time.ticks_diff(time.ticks_ms(), last_trigger_ms) // 1000
    return "{} sec ago".format(age)


def make_page(wlan):
    ip = wlan.ifconfig()[0]
    active = opto_active()
    relay_status = relay_status_payload()
    post_class = "ok" if last_post_ok is True else ("bad" if last_post_ok is False else "")
    return """<!doctype html>
<html><head><meta charset='utf-8'>
<meta name='viewport' content='width=device-width,initial-scale=1'>
<title>Shyvers Multiphone Pico</title>
<style>
body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#111;color:#eee;margin:0;padding:24px}}
.card{{max-width:620px;margin:auto;background:#1d1d1f;border-radius:16px;padding:24px}}
h1{{margin-top:0}} .online{{display:inline-block;background:#244c2a;padding:6px 10px;border-radius:999px;font-weight:700}}
table{{width:100%;border-collapse:collapse;margin-top:20px}} td{{padding:9px 0;border-bottom:1px solid #333}} td:first-child{{color:#aaa}} td:last-child{{text-align:right;font-family:monospace}}
.ok{{color:#7ee787}} .bad{{color:#ff7b72}} .foot{{color:#777;font-size:12px;margin-top:18px}}
</style></head><body><div class='card'>
<h1>Shyvers Multiphone Pico</h1><div class='online'>ONLINE</div>
<table>
<tr><td>IP address</td><td>{}</td></tr>
<tr><td>Uptime</td><td>{}</td></tr>
<tr><td>GPIO</td><td>GP{}</td></tr>
<tr><td>Raw input</td><td>{}</td></tr>
<tr><td>Optocoupler</td><td>{}</td></tr>
<tr><td>Armed</td><td>{}</td></tr>
<tr><td>Trigger count</td><td>{}</td></tr>
<tr><td>Last trigger</td><td>{}</td></tr>
<tr><td>Last POST</td><td class='{}'>{}</td></tr>
<tr><td>GP16 relay raw level</td><td>{}</td></tr>
<tr><td>GP16 relay mode</td><td>{}</td></tr>
<tr><td>Relay interpreted state</td><td>{}</td></tr>
<tr><td>Automatic relay control</td><td>{}</td></tr>
<tr><td>OTA status</td><td>{}</td></tr>
</table>
<label><input id='auto-refresh' type='checkbox' onchange='toggleAutoRefresh()'>
Auto-refresh status every 5 seconds</label>
<h2>Relay polarity test</h2>
<p>These controls set the raw GP16 output level. Observe the jewel lamp and
record which level energizes the relay.</p>
<label>Relay test token:
<input id='relay-token' type='password' autocomplete='off'></label>
<button type='button' onclick='setRelayLevel(0)'>Set GP16 level 0</button>
<button type='button' onclick='setRelayLevel(1)'>Set GP16 level 1</button>
<pre id='relay-result'>Awaiting a test command.</pre>
<script>
async function setRelayLevel(level) {{
  const token = document.getElementById('relay-token').value.trim();
  const result = document.getElementById('relay-result');
  if (!token) {{ result.textContent = 'Enter the relay test token first.'; return; }}
  result.textContent = 'Setting GP16 level ' + level + '...';
  try {{
    const response = await fetch('/relay/test?level=' + level, {{
      method: 'POST', headers: {{'Authorization': 'Bearer ' + token}}
    }});
    const data = await response.json();
    result.textContent = 'HTTP ' + response.status + '\\n' + JSON.stringify(data, null, 2);
  }} catch (error) {{
    result.textContent = 'ERROR: ' + error;
  }}
}}
</script>
<script>
let refreshTimer = null;
const refreshKey = 'shyvers-multiphone-auto-refresh';
function toggleAutoRefresh() {{
  const enabled = document.getElementById('auto-refresh').checked;
  localStorage.setItem(refreshKey, enabled ? '1' : '0');
  if (refreshTimer) clearInterval(refreshTimer);
  if (enabled) refreshTimer = setInterval(() => location.reload(), 5000);
}}
const refreshBox = document.getElementById('auto-refresh');
refreshBox.checked = localStorage.getItem(refreshKey) === '1';
toggleAutoRefresh();
</script>
<div class='foot'>Auto-refreshes every 5 seconds. Shyvers is busy!!</div>
</div></body></html>""".format(
        ip, uptime_text(), OPTO_PIN, opto.value(),
        "ACTIVE" if active else "inactive",
        "YES" if armed else "NO",
        trigger_count, last_trigger_text(), post_class, last_post_status,
        "unknown" if relay_status["rawLevel"] is None else relay_status["rawLevel"],
        relay_status["mode"], relay_status["interpretedState"],
        "ENABLED" if relay_status["automaticControl"] else "DISABLED",
        last_ota_status,
    )


def send_all(client, data):
    sent_total = 0
    while sent_total < len(data):
        sent = client.send(data[sent_total:])
        if not sent:
            raise OSError("socket send failed")
        sent_total += sent


def http_response(client, status, body, content_type="application/json"):
    payload = body.encode()
    header = (
        "HTTP/1.1 {}\r\n"
        "Content-Type: {}; charset=utf-8\r\n"
        "Content-Length: {}\r\n"
        "Cache-Control: no-store\r\n"
        "Connection: close\r\n\r\n"
    ).format(status, content_type, len(payload))
    send_all(client, header.encode())
    send_all(client, payload)


def read_request(client):
    """Read request headers and return method, path, headers, body prefix."""
    data = b""
    while b"\r\n\r\n" not in data and len(data) <= 4096:
        chunk = client.recv(512)
        if not chunk:
            break
        data += chunk

    marker = data.find(b"\r\n\r\n")
    if marker < 0 or marker > 4096:
        raise ValueError("incomplete or oversized HTTP headers")

    lines = data[:marker].split(b"\r\n")
    request_parts = lines[0].decode().split()
    if len(request_parts) != 3:
        raise ValueError("malformed request line")

    headers = {}
    for line in lines[1:]:
        if b":" not in line:
            raise ValueError("malformed HTTP header")
        name, value = line.split(b":", 1)
        headers[name.decode().lower().strip()] = value.decode().strip()

    try:
        content_length = int(headers.get("content-length", "0"))
    except ValueError:
        raise ValueError("invalid Content-Length")
    if content_length < 0 or content_length > OTA_MAX_BYTES:
        raise ValueError("upload exceeds {} bytes".format(OTA_MAX_BYTES))

    return request_parts[0], request_parts[1], headers, data[marker + 4:], content_length


def query_value(path, name):
    if "?" not in path:
        return None
    query = path.split("?", 1)[1]
    for item in query.split("&"):
        parts = item.split("=", 1)
        if len(parts) == 2 and parts[0] == name:
            return parts[1]
    return None


def relay_test_authorized(headers):
    if not RELAY_TEST_TOKEN:
        return False, "relay test disabled: RELAY_TEST_TOKEN missing"
    if headers.get("authorization", "") != "Bearer " + RELAY_TEST_TOKEN:
        return False, "unauthorized"
    return True, None


def receive_ota_file(client, initial_body, content_length):
    """Receive a complete upload into the temporary file."""
    if len(initial_body) > content_length:
        raise ValueError("request body exceeds Content-Length")

    received = 0
    with open(OTA_TEMP_FILE, "wb") as upload:
        if initial_body:
            upload.write(initial_body)
            received = len(initial_body)
        while received < content_length:
            chunk = client.recv(min(1024, content_length - received))
            if not chunk:
                raise ValueError("upload ended early ({}/{})".format(received, content_length))
            upload.write(chunk)
            received += len(chunk)
        upload.flush()

    if received != content_length:
        raise ValueError("incomplete upload ({}/{})".format(received, content_length))


def receive_request_body(client, initial_body, content_length):
    if len(initial_body) > content_length:
        raise ValueError("request body exceeds Content-Length")
    body = initial_body
    while len(body) < content_length:
        chunk = client.recv(min(512, content_length - len(body)))
        if not chunk:
            raise ValueError("request body ended early")
        body += chunk
    return body


def mabel_config_authorized(headers):
    if not OTA_TOKEN:
        return False, "Mabel URL configuration disabled: OTA_TOKEN missing"
    if headers.get("authorization", "") != "Bearer " + OTA_TOKEN:
        return False, "unauthorized"
    return True, None


def configure_mabel_url(body):
    global MABEL_URL
    value = body.decode().strip()
    parse_http_url(value)
    with open(MABEL_URL_FILE, "w") as config_file:
        config_file.write(value)
        config_file.flush()
    MABEL_URL = value
    print("Mabel URL configured: {}".format(value))


def safe_remove(path):
    try:
        os.remove(path)
    except OSError:
        pass


def install_ota_file():
    """Validate and install the complete staged file, retaining a backup."""
    with open(OTA_TEMP_FILE, "rb") as upload:
        source = upload.read()
    compile(source, OTA_TEMP_FILE, "exec")

    safe_remove(OTA_BACKUP_FILE)
    os.rename("main.py", OTA_BACKUP_FILE)
    try:
        os.rename(OTA_TEMP_FILE, "main.py")
    except Exception:
        os.rename(OTA_BACKUP_FILE, "main.py")
        raise


def start_server():
    addr = socket.getaddrinfo("0.0.0.0", HTTP_PORT)[0][-1]
    s = socket.socket()
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    except Exception:
        pass
    s.bind(addr)
    s.listen(2)
    s.setblocking(False)
    return s


def service_web(server, wlan):
    global last_ota_status, ota_reboot_pending
    try:
        client, addr = server.accept()
    except OSError:
        return

    try:
        client.settimeout(10)
        method, request_path, headers, initial_body, content_length = read_request(client)
        path = request_path.split("?", 1)[0]

        if path == "/" and method == "GET":
            html = make_page(wlan)
            http_response(client, "200 OK", html, "text/html")
        elif path == RELAY_STATUS_PATH and method == "GET":
            http_response(client, "200 OK", json.dumps(relay_status_payload()))
        elif path in (RELAY_ON_PATH, RELAY_OFF_PATH) and method == "POST":
            authorized, error = relay_test_authorized(headers)
            if not authorized:
                status = "503 Service Unavailable" if "disabled" in error else "401 Unauthorized"
                http_response(client, status, json.dumps({"ok": False, "error": error}))
            else:
                set_relay_automatic(path == RELAY_ON_PATH)
                http_response(client, "200 OK", json.dumps(relay_status_payload()))
        elif path == RELAY_TEST_PATH and method == "POST":
            authorized, error = relay_test_authorized(headers)
            if not authorized:
                status = "503 Service Unavailable" if "disabled" in error else "401 Unauthorized"
                http_response(client, status, json.dumps({"ok": False, "error": error}))
            else:
                try:
                    level = int(query_value(request_path, "level") or "-1")
                    set_relay_test_level(level)
                    http_response(client, "200 OK", json.dumps(relay_status_payload()))
                except (TypeError, ValueError) as exc:
                    http_response(client, "400 Bad Request", json.dumps({"ok": False, "error": str(exc)}))
        elif path == MABEL_CONFIG_PATH and method == "POST":
            authorized, error = mabel_config_authorized(headers)
            if not authorized:
                status = "503 Service Unavailable" if "disabled" in error else "401 Unauthorized"
                http_response(client, status, json.dumps({"ok": False, "error": error}))
            else:
                try:
                    body = receive_request_body(client, initial_body, content_length)
                    configure_mabel_url(body)
                    http_response(client, "200 OK", json.dumps(relay_status_payload()))
                except Exception as exc:
                    http_response(client, "400 Bad Request", json.dumps({"ok": False, "error": str(exc)}))
        elif path == OTA_PATH and method == "POST":
            expected_auth = "Bearer " + (OTA_TOKEN or "")
            if not OTA_TOKEN:
                last_ota_status = "disabled: OTA_TOKEN missing"
                http_response(client, "503 Service Unavailable", '{"ok":false,"error":"OTA disabled"}')
            elif headers.get("authorization", "") != expected_auth:
                last_ota_status = "rejected: unauthorized"
                http_response(client, "401 Unauthorized", '{"ok":false,"error":"unauthorized"}')
            else:
                try:
                    receive_ota_file(client, initial_body, content_length)
                    install_ota_file()
                    last_ota_status = "installed; reboot pending"
                    http_response(client, "200 OK", '{"ok":true,"rebooting":true}')
                    ota_reboot_pending = True
                except Exception as error:
                    safe_remove(OTA_TEMP_FILE)
                    last_ota_status = "failed: {}".format(error)
                    print("OTA ERROR:", error)
                    http_response(client, "400 Bad Request", '{"ok":false,"error":"OTA rejected"}')
        else:
            http_response(client, "404 Not Found", '{"ok":false,"error":"not found"}')
    except Exception as exc:
        print("Web request error:", exc)
    finally:
        try:
            client.close()
        except Exception:
            pass


def main():
    global armed, startup_ready, ota_reboot_pending
    print("BOOTED main.py")
    wlan = connect_wifi()
    server = start_server()

    print("Watching optocoupler on GPIO", OPTO_PIN)
    print("ACTIVE_LOW =", ACTIVE_LOW)
    print("GP16 relay test endpoint: POST /relay/test?level=0 or 1")
    print("GP16 automatic control: ENABLED (active-high)")
    print("Status page: http://{}/".format(wlan.ifconfig()[0]))
    print("Waiting for GP15 inactive startup qualification.")

    active_since = None
    inactive_since = None
    startup_inactive_since = None

    while True:
        now = time.ticks_ms()
        active = opto_active()

        service_web(server, wlan)

        if ota_reboot_pending:
            print("OTA installed; rebooting")
            time.sleep_ms(500)
            machine.reset()

        if not wlan.isconnected():
            print("Wi-Fi disconnected; reconnecting...")
            try:
                server.close()
            except Exception:
                pass
            wlan = connect_wifi()
            server = start_server()
            print("Status page: http://{}/".format(wlan.ifconfig()[0]))

        if not startup_ready:
            if not active:
                if startup_inactive_since is None:
                    startup_inactive_since = now
                elif time.ticks_diff(now, startup_inactive_since) >= STARTUP_ARM_MS:
                    startup_ready = True
                    armed = True
                    startup_inactive_since = None
                    print("Startup qualification passed; armed")
            else:
                startup_inactive_since = None
        elif armed:
            if active:
                if active_since is None:
                    active_since = now
                elif time.ticks_diff(now, active_since) >= ACTIVE_DEBOUNCE_MS:
                    start_normal_mabel()
                    armed = False
                    active_since = None
                    inactive_since = None
            else:
                active_since = None
        else:
            if not active:
                if inactive_since is None:
                    inactive_since = now
                elif time.ticks_diff(now, inactive_since) >= REARM_MS:
                    armed = True
                    inactive_since = None
                    print("Re-armed")
            else:
                inactive_since = None

        gc.collect()
        time.sleep_ms(POLL_MS)


try:
    main()
except KeyboardInterrupt:
    print("Stopped.")
