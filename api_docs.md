# DroidClaw Bridge — API Documentation

Remote Android device automation through a WebSocket bridge. An AccessibilityService
on each phone connects to this server; an orchestrator (LLM agent / script) sends
JSON commands and receives UI trees, screenshots, and action results.

Audience: LLM agents driving real Android devices. Read "Golden rules" before acting.

---

## 1. Architecture

```
┌───────────┐  WS :7334 /bridge   ┌──────────────┐  WS :7335  ┌──────────────┐
│ Android   │ ◄──────────────────►│ DroidClaw    │◄───────────►│ Orchestrator │
│ device    │   (device token)    │ Bridge       │  + HTTP     │ (you: agent) │
│ Accessi-  │                     │ server.js    │ localhost   └──────────────┘
│ bilitySvc │                     │ (Node, no    │
└───────────┘                     │  deps)       │
                                  └──────────────┘
```

- **Port 7334** — devices dial IN (WS path `/bridge`, header `x-device-token: <BOOTSTRAP_TOKEN>`). Registration frame:
  `{"type":"register","token":"…","device_id":"<rustdesk peer id>","stable_id":"<ANDROID_ID>","device":"Xiaomi Redmi Note 8"}`
  Devices auto-reconnect (1s→60s backoff) and re-register; the ID poller re-registers when the RustDesk peer ID changes.
- **Port 7335** — orchestrator interface, two equivalent transports:
  - **HTTP** (recommended, curl-friendly): `GET /status`, `GET /devices`, `POST /command`
  - **WebSocket** (raw JSON frames, same semantics as below)
- **Bridge host**: `31.76.87.43` / `185.113.138.162` (this VPS). From on-server use `localhost:7335`.
- Command timeout: default **30 s**, override per-request via `"timeout"` (max 120 s). If the device doesn't answer in time → `{"error":"timeout"}` (HTTP 504).
- Bridge runs via `node /root/DroidClaw-bridge/server.js`. Restart is safe: devices reconnect automatically within seconds.

### Bootstrap token
```
af748a97422fa9652998395f18145a027c02d8bdde68633b
```
(Only needed if you run your own bridge or debug the device side.)

---

## 2. Quick start (HTTP)

```bash
# health + device inventory
curl -s localhost:7335/status
# {"devices":1,"pending":0,"uptime":4416.4}

curl -s localhost:7335/devices
# {"devices":[{"device_id":"1422411041","stable_id":"f1eb…","device":"Xiaomi Redmi Note 8","connected_at":…}]}

# send a command (device_id optional when exactly ONE device connected — auto-routed)
curl -s localhost:7335/command -d '{"command":{"type":"ping"}}'
# {"id":"…","device_id":"1422411041","result":{"status":"ok","service":"rustdesk-warmer"}}
```

Helper script (same thing, shorter):
```bash
/root/DroidClaw-bridge/dc.sh '{"type":"get_screen","compact":true}' 45000
```

POST body shapes (both accepted):
```json
{"command": {"type":"tap","x":540,"y":724}}
{"device_id":"1422411041","command":{…},"timeout":60000}
{"stable_id":"f1eb…","command":{…}}
```

HTTP status codes: 200 ok (also on device-level `error` inside result), 404 device not
connected, 504 command timeout, 400 bad JSON. The JSON body always mirrors the WS
protocol: `{"id":"…","device_id":"…","result":{…}}` or `{"id":"…","error":"…"}`.

---

## 3. Command reference (device side, `WarmerCommandExecutor`)

All commands execute against the active window of the phone via AccessibilityService.

### Observe

| Command | Args | Result |
|---|---|---|
| `get_screen` | `compact: bool` | `{package, timestamp, count, nodes:[…]}` — full UI tree, screen px coords |
| `screenshot` | `max_dim` (default 1080), `quality` (20–95, default 70) | `{ok, mime:"image/jpeg", width, height, base64}` — needs Android 11+ |
| `list_packages` | `system: bool` (default true), `launchable_only: bool` | `{count, packages:[{package,label,system}]}` |
| `ping` | — | `{status:"ok", service:"rustdesk-warmer"}` |
| `network_speed` | — | speed test result (up/down/latency) |

**Node fields in `get_screen`** (compact mode; non-compact adds `cls`,`depth`):
```json
{"text":"Login","desc":"optional content description","id":"com.example:id/btn",
 "bounds":"left,top,right,bottom","click":true,"edit":true,"scroll":true,
 "checkable":true,"checked":true,"focused":true,"selected":true}
```
Only interesting nodes are present in compact mode (has text/desc or is clickable/editable/scrollable/checkable).
`bounds` are pixel coords on the device screen (e.g. 1080×2340). Center = tap point:
`x=(l+r)/2, y=(t+b)/2`.

### Act

| Command | Args | Result / notes |
|---|---|---|
| `click` | one of: `text` (substring, case-insensitive), `id` (substring of viewId), `desc` (substring) | `{clicked,x,y}` — walks up ≤5 parents to find clickable ancestor; in browsers dispatches a real tap gesture so JS handlers fire. **`text` match is substring** — `"Verify"` matches `"Verify your phone number"`. |
| `tap` | `x, y` (int px) | `{tapped,x,y}` — raw gesture 90–130ms. Most predictable action. |
| `input_text` | `text` (required); `id`/`desc` optional | `{ok,text}` — targets by id/desc → focused editable → first editable + click. Android `ACTION_SET_TEXT`. |
| `scroll` | `direction:"down"|"up"` (default down), `duration` ms (default 300) | `{scrolled,direction}` — clears focused input first (IME guard). Note: `"down"` = content scrolls down (finger up), `"up"` = content up (finger down) — see §5. |
| `enter` | — | `{ok}` — best-effort form submit: IME action on focused field → known submit-button ids/texts → fallback tap bottom-right. |
| `open_url` | `url`, `new_tab` (default false), `package` (default `com.android.chrome`) | `{opened,…}` — Chrome omnibox navigation or Intent fallback. |
| `launch_app` | `package` | `{launched}` — `getLaunchIntentForPackage`. Requires APK built with `QUERY_ALL_PACKAGES` (current build has it). |
| `back` / `home` / `notifications` | — | `{ok,action}` — system global actions. |

---

## 4. Recommended agent loop

```
1. GET /devices                          → pick target device
2. {"type":"ping"}                       → confirm link alive
3. {"type":"launch_app",…} or user is on screen
4. loop:
     get_screen (compact)                 → read nodes, find target bounds
     tap/click/input_text                 → act
     short wait (1–3 s; 5–8 s for page transitions)
     get_screen again                     → VERIFY state changed as expected
5. stop when goal screen reached
```

**Always re-read the screen after every act step.** The phone is a real device with
network latency, popups, keyboard animations. A result `{"ok":true}` only means the
action was dispatched, not that the UI advanced.

---

## 5. Golden rules & known pitfalls (READ BEFORE DRIVING)

1. **Tap by coordinates beats click by text.** `click` matches substrings and can hit a
   heading instead of the button below it (both contain the word). Prefer: locate node →
   compute center of its `bounds` → `tap`. Use `click` only for unique text.
2. **Pop-up menus need 2 taps.** First tap on e.g. "Create account" opens a dropdown whose
   items only appear on the NEXT `get_screen`. If a tap "succeeded" but the tree is
   unchanged, the menu probably opened (or a dialog dimmed) — re-read the screen,
   or `screenshot` to disambiguate.
3. **Soft keyboard hijacks scrolls and taps.** `scroll` already dismisses focus first.
   After `input_text`, if you tap below the field you may hit keyboard keys. Re-`get_screen`
   after typing; the keyboard shifts `bounds`.
4. **`input_text` id collision:** fields like `firstName` also have `firstName-label-id`;
   id matching is substring → may hit the label (SET_TEXT silently fails, `ok:false`).
   Reliable pattern: `tap` the field center → `input_text` with **no id** (goes to focused field).
5. **Screen is asleep?** Tap/wake first (`tap` at screen center), or the tree shows `com.android.systemui`
   lock/shade nodes. If you see `Lock screen`/`accessibility_actions_view`, the device is locked —
   unlock via PIN fields in the tree, or ask the user.
6. **Long transitions**: OAuth, account creation, page loads take 3–10 s. Wait, re-read.
   Device-side `open_url`/`launch_app` already sleep 2.5–3 s internally.
7. **Screenshot for ambiguous states**, get_screen for interaction. OCR is not on-device;
   read `text`/`desc` fields instead.
8. **Coordinates are device pixels**, not screenshot pixels. `screenshot` may be downscaled
   (`width`/`height` in result) — map back: `x_real = x_shot * (1080/width)`.
9. **Don't spam commands**: one command = one WS round-trip ≤ 30 s; keep a single open
   session for interactive flows.
10. **Destructive actions** (logout, delete account, payments, sending messages to real
    contacts): confirm with the human operator before tapping.

---

## 6. Worked example — register a Google account (abridged)

```bash
DC=/root/DroidClaw-bridge/dc.sh
$DC '{"type":"launch_app","package":"com.google.android.gm"}' 45000   # 1. open Gmail
$DC '{"type":"get_screen","compact":true}'                              # 2. find avatar "Signed in as…" node, tap center
$DC '{"type":"tap","x":1011,"y":154}'
$DC '{"type":"tap","x":540,"y":463}'   # 3. "Add another account" row
sleep 8                                #    Google chosen → "Checking info"…
$DC '{"type":"tap","x":250,"y":1014}'  # 4. "Create account" (opens dropdown)
$DC '{"type":"tap","x":231,"y":1136}'  # 5. "For my personal use" (bounds from re-read!)
$DC '{"type":"tap","x":420,"y":678}'; $DC '{"type":"input_text","text":"John"}'  # 6. name (focused)
$DC '{"type":"tap","x":540,"y":915}'; $DC '{"type":"input_text","text":"Doe"}'   #    last name
$DC '{"type":"tap","x":540,"y":1269}'  # 7. Next → basic info
$DC '{"type":"tap","x":540,"y":621}'; $DC '{"type":"tap","x":211,"y":762}'        #    month dropdown → January
$DC '{"type":"tap","x":420,"y":621}'; $DC '{"type":"input_text","text":"12"}'     #    day
$DC '{"type":"tap","x":869,"y":621}'; $DC '{"type":"input_text","text":"2000"}'   #    year
$DC '{"type":"tap","x":540,"y":789}'; $DC '{"type":"tap","x":540,"y":1042}'       #    gender dropdown → Male
$DC '{"type":"click","text":"Next"}'                                        # 8. username page
$DC '{"type":"tap","x":420,"y":678}'; $DC '{"type":"input_text","text":"johndoe777410"}'
$DC '{"type":"click","text":"Next"}'                                        # 9. password page
$DC '{"type":"tap","x":540,"y":780}'; $DC '{"type":"input_text","text":"…"}'  #    c16
$DC '{"type":"enter"}'; $DC '{"type":"input_text","text":"…"}'               #    focus→c17 (don't tap!)
$DC '{"type":"click","text":"Next"}'                                        # 10. phone verification:
#     auto-passes ("This may take a few moments" ~12 s) OR needs user's number + SMS code
# 11. ToS: scroll 3-4× ("I agree" disabled until page end) → tap → "Add a selfie" → Not now
# 12. VERIFY: Gmail account list shows the new address
```
Full playbook: skill `remote-android-automation`, `references/reggmail-flow.md`.

---

## 7. WebSocket protocol (alternative transport)

Connect `ws://HOST:7335` (no auth on orchestrator port). Frames:

```json
→ {"type":"list_devices"}
← {"devices":[{"device_id":"1422411041","stable_id":"f1eb…","device":"Xiaomi Redmi Note 8","connected_at":1789819604189}]}

→ {"type":"command","device_id":"1422411041","command":{"type":"get_screen","compact":true}}
← {"id":"<hex assigned by bridge>","device_id":"1422411041","result":{…}}

→ {"type":"command","stable_id":"f1eb…","command":{…}}   // stable id = ANDROID_ID, survives peer-id rotation
→ {"type":"ping","device_id":"1422411041"}
← {"id":"…","result":{"status":"ok","service":"rustdesk-warmer"}}
```

Responses are asynchronous and keyed by `id`; correlate on it (multiple in-flight commands OK).
**id wrapping caveat:** the bridge rewrites the top-level `id` of your command object to its
tracking hex and moves your original value into `view_id`; the device resolves `click`/`input_text`
targets via `view_id` — so pass `{"type":"click","view_id":"com.example:id/btn"}` for id-based clicks.

## 8. Files on this host

| Path | Purpose |
|---|---|
| `/root/DroidClaw-bridge/server.js` | bridge (Node 18+, no deps except `ws` for examples) |
| `/root/DroidClaw-bridge/dc.sh` | one-liner curl helper |
| `/root/DroidClaw-bridge/orchestrator_example.js` | minimal WS example |
| `/root/rustdesk/flutter/android/…/WarmerService.kt` | device: WS client + registration |
| `/root/rustdesk/flutter/android/…/WarmerCommandExecutor.kt` | device: command implementation (source of truth for behavior) |
| `/root/rustdesk/flutter/android/…/AndroidManifest.xml` | `QUERY_ALL_PACKAGES` + `/bridge` connect |

*Bridge uptime restarts are transparent to devices (auto-reconnect ~1 s).*
*Doc generated: 2026-09-19.*
