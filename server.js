/**
 * OpenClaw Bridge Server
 *
 * Порт 7334 — устройства (Android, AccessibilityService)
 * Порт 7335 — оркестратор (ваш скрипт / LLM-агент / API)
 *
 * Протокол устройства:
 *   → {"type":"register","token":"...","device_id":"123","stable_id":"aabbcc","device":"Samsung S24"}
 *   ← {"type":"command","id":"hexid","view_id":"original_id",...тело команды...}
 *   → {"id":"hexid","result":{...}}
 *
 * Протокол оркестратора (WebSocket на порт 7335):
 *   → {"type":"list_devices"}
 *   ← {"devices":[{"device_id":"123","device":"Samsung S24","connected_at":1234567890},...]}
 *
 *   → {"type":"command","device_id":"123","command":{"type":"get_screen","compact":true}}
 *   ← {"id":"hexid","device_id":"123","result":{...}}   (ответ когда устройство ответит)
 *
 *   → {"type":"command","stable_id":"aabbcc","command":{"type":"screenshot"}}
 *   ← {"id":"hexid","result":{...}}
 *
 *   → {"type":"ping","device_id":"123"}
 *   ← {"id":"...","result":{"status":"ok","service":"rustdesk-warmer"}}
 */

"use strict";

const net        = require("net");
const http       = require("http");
const crypto     = require("crypto");

const DEVICE_PORT       = 7334;
const ORCHESTRATOR_PORT = 7335;
const BRIDGE_PATH       = "/bridge";
const BOOTSTRAP_TOKEN   = "af748a97422fa9652998395f18145a027c02d8bdde68633b";
const COMMAND_TIMEOUT_MS = 30_000;

// ── State ────────────────────────────────────────────────────────────────────

// device_id  → DeviceConnection
// stable_id  → DeviceConnection  (secondary index)
const deviceById    = new Map();   // device_id → conn
const deviceByStable = new Map();  // stable_id → conn

// pending commands waiting for device response
// id (hex) → { resolve, reject, timer, orchestratorWs }
const pending = new Map();

// connected orchestrators
const orchestrators = new Set();

// ── Helpers ──────────────────────────────────────────────────────────────────

function genId() {
    return crypto.randomBytes(8).toString("hex");
}

function log(tag, msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [${tag}] ${msg}`);
}

function sendWs(ws, obj) {
    try {
        if (ws && ws.writable) ws.send(JSON.stringify(obj));
    } catch (e) {
        log("WARN", `sendWs failed: ${e.message}`);
    }
}

// ── WebSocket server (raw) ───────────────────────────────────────────────────
// Minimal RFC-6455 implementation — no deps.

function computeAccept(key) {
    return crypto
        .createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
}

function makeWsSocket(socket) {
    let messageBuffer = Buffer.alloc(0);

    const ws = {
        writable: true,
        _socket: socket,

        send(text) {
            const payload = Buffer.from(text, "utf8");
            const frame   = encodeFrame(payload, false);
            socket.write(frame);
        },

        close() {
            try { socket.destroy(); } catch (_) {}
        },

        onmessage: null,
        onclose:   null,
    };

    socket.on("data", (chunk) => {
        messageBuffer = Buffer.concat([messageBuffer, chunk]);
        while (messageBuffer.length >= 2) {
            const result = decodeFrame(messageBuffer);
            if (!result) break;
            const { text, consumed, opcode } = result;
            messageBuffer = messageBuffer.slice(consumed);
            if (opcode === 0x8) {                        // close
                ws.writable = false;
                socket.destroy();
                if (ws.onclose) ws.onclose();
                break;
            }
            if (opcode === 0x9) {                        // ping → pong
                socket.write(encodeFrame(Buffer.from(text, "utf8"), false, 0xA));
                continue;
            }
            if (ws.onmessage) ws.onmessage(text);
        }
    });

    socket.on("close", () => {
        ws.writable = false;
        if (ws.onclose) ws.onclose();
    });
    socket.on("error", () => {
        ws.writable = false;
        if (ws.onclose) ws.onclose();
    });

    return ws;
}

function encodeFrame(payload, masked, opcode = 0x81) {
    const len    = payload.length;
    let header;

    if (len <= 125) {
        header = Buffer.alloc(masked ? 6 : 2);
        header[0] = opcode;
        header[1] = (masked ? 0x80 : 0) | len;
        if (masked) {
            const m = crypto.randomBytes(4);
            m.copy(header, 2);
            for (let i = 0; i < len; i++) payload[i] ^= m[i % 4];
        }
    } else if (len <= 65535) {
        header = Buffer.alloc(masked ? 8 : 4);
        header[0] = opcode;
        header[1] = (masked ? 0x80 : 0) | 126;
        header.writeUInt16BE(len, 2);
        if (masked) {
            const m = crypto.randomBytes(4);
            m.copy(header, 4);
            for (let i = 0; i < len; i++) payload[i] ^= m[i % 4];
        }
    } else {
        header = Buffer.alloc(masked ? 14 : 10);
        header[0] = opcode;
        header[1] = (masked ? 0x80 : 0) | 127;
        header.writeBigUInt64BE(BigInt(len), 2);
        if (masked) {
            const m = crypto.randomBytes(4);
            m.copy(header, 10);
            for (let i = 0; i < len; i++) payload[i] ^= m[i % 4];
        }
    }

    return Buffer.concat([header, payload]);
}

function decodeFrame(buf) {
    if (buf.length < 2) return null;
    const fin    = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0F;
    const masked = (buf[1] & 0x80) !== 0;
    let   payLen = buf[1] & 0x7F;
    let   offset = 2;

    if (payLen === 126) {
        if (buf.length < 4) return null;
        payLen = buf.readUInt16BE(2);
        offset = 4;
    } else if (payLen === 127) {
        if (buf.length < 10) return null;
        payLen = Number(buf.readBigUInt64BE(2));
        offset = 10;
    }

    if (masked) offset += 4;
    if (buf.length < offset + payLen) return null;

    const payload = Buffer.alloc(payLen);
    buf.copy(payload, 0, masked ? offset : offset, offset + payLen);
    if (masked) {
        const maskKey = buf.slice(offset - 4, offset);
        for (let i = 0; i < payLen; i++) payload[i] ^= maskKey[i % 4];
    }

    return { text: payload.toString("utf8"), consumed: offset + payLen, opcode, fin };
}

// ── HTTP upgrade handler ─────────────────────────────────────────────────────

function handleUpgrade(req, socket, head, role) {
    const key    = req.headers["sec-websocket-key"];
    const accept = computeAccept(key);

    socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        "\r\n"
    );

    const ws = makeWsSocket(socket);
    if (role === "device")       handleDeviceSocket(ws, req);
    else if (role === "orchestrator") handleOrchestratorSocket(ws);
}

// ── Device socket ────────────────────────────────────────────────────────────

function handleDeviceSocket(ws, req) {
    let deviceId   = null;
    let stableId   = null;
    let deviceName = "unknown";

    ws.onmessage = (text) => {
        let msg;
        try { msg = JSON.parse(text); } catch (_) { return; }

        // Registration frame
        if (msg.type === "register") {
            if (msg.token !== BOOTSTRAP_TOKEN) {
                log("DEVICE", "bad token, closing");
                ws.close(); return;
            }

            // Remove stale registrations for this device
            if (deviceId) { deviceById.delete(deviceId); }
            if (stableId) { deviceByStable.delete(stableId); }

            deviceId   = msg.device_id  || null;
            stableId   = msg.stable_id  || null;
            deviceName = msg.device     || "android";

            if (deviceId) deviceById.set(deviceId, ws);
            if (stableId) deviceByStable.set(stableId, ws);

            log("DEVICE", `registered id=${deviceId ?? "<legacy>"} stable=${stableId ?? "<none>"} name="${deviceName}"`);

            // Attach metadata to ws for listing
            ws._deviceId   = deviceId;
            ws._stableId   = stableId;
            ws._deviceName = deviceName;
            ws._connectedAt = Date.now();
            return;
        }

        // Command response: {"id":"hexid","result":{...}} or {"id":"...","error":"..."}
        const pendingCmd = pending.get(msg.id);
        if (pendingCmd) {
            clearTimeout(pendingCmd.timer);
            pending.delete(msg.id);
            const resp = {
                id:        msg.id,
                device_id: deviceId,
                ...(msg.result ? { result: msg.result } : { error: msg.error }),
            };
            sendWs(pendingCmd.orchestratorWs, resp);
        }
    };

    ws.onclose = () => {
        if (deviceId) deviceById.delete(deviceId);
        if (stableId) deviceByStable.delete(stableId);
        ws.writable = false;
        log("DEVICE", `disconnected id=${deviceId ?? "<legacy>"}`);
    };
}

// ── Orchestrator socket ──────────────────────────────────────────────────────

function handleOrchestratorSocket(ws) {
    log("ORCH", "orchestrator connected");
    orchestrators.add(ws);

    ws.onmessage = (text) => {
        let msg;
        try { msg = JSON.parse(text); } catch (_) {
            sendWs(ws, { error: "invalid JSON" }); return;
        }

        if (msg.type === "list_devices") {
            const list = [];
            for (const dws of deviceById.values()) {
                list.push({
                    device_id:    dws._deviceId,
                    stable_id:    dws._stableId  ?? null,
                    device:       dws._deviceName,
                    connected_at: dws._connectedAt,
                });
            }
            sendWs(ws, { devices: list });
            return;
        }

        if (msg.type === "command" || msg.type === "ping") {
            // Resolve target device
            let targetWs = null;
            if (msg.device_id)  targetWs = deviceById.get(msg.device_id)   ?? null;
            if (!targetWs && msg.stable_id) targetWs = deviceByStable.get(msg.stable_id) ?? null;

            if (!targetWs || !targetWs.writable) {
                sendWs(ws, { error: "device not connected", device_id: msg.device_id ?? null });
                return;
            }

            // For "ping" shorthand
            const command = msg.type === "ping"
                ? { type: "ping" }
                : msg.command;

            if (!command) {
                sendWs(ws, { error: "missing 'command' field" }); return;
            }

            // The bridge assigns its own tracking id. The original command id
            // (if any) is preserved as view_id so the executor can use it.
            const bridgeId  = genId();
            const outCmd = {
                ...command,
                id:      bridgeId,
                view_id: command.id ?? command.view_id ?? "",
            };

            targetWs.send(JSON.stringify(outCmd));
            log("ORCH", `→ device ${targetWs._deviceId} cmd=${command.type} tracking=${bridgeId}`);

            // Register pending callback
            const timer = setTimeout(() => {
                if (pending.has(bridgeId)) {
                    pending.delete(bridgeId);
                    sendWs(ws, { id: bridgeId, error: "timeout", device_id: targetWs._deviceId });
                }
            }, COMMAND_TIMEOUT_MS);

            pending.set(bridgeId, { orchestratorWs: ws, timer });
            return;
        }

        sendWs(ws, { error: `unknown type: ${msg.type}` });
    };

    ws.onclose = () => {
        orchestrators.delete(ws);
        log("ORCH", "orchestrator disconnected");
    };
}

// ── Device server (port 7334) ────────────────────────────────────────────────

const deviceServer = http.createServer((req, res) => {
    res.writeHead(200).end("OpenClaw Bridge\n");
});

deviceServer.on("upgrade", (req, socket, head) => {
    if (req.url !== BRIDGE_PATH) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy(); return;
    }
    const token = req.headers["x-device-token"];
    if (token !== BOOTSTRAP_TOKEN) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy(); return;
    }
    handleUpgrade(req, socket, head, "device");
});

deviceServer.listen(DEVICE_PORT, () => {
    log("BRIDGE", `device server listening on :${DEVICE_PORT}`);
});

// ── Orchestrator server (port 7335) ──────────────────────────────────────────

const orchServer = http.createServer((req, res) => {
    // Optional: simple HTTP status endpoint
    if (req.method === "GET" && req.url === "/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            devices:    deviceById.size,
            pending:    pending.size,
            uptime:     process.uptime(),
        }));
        return;
    }
    res.writeHead(200).end("OpenClaw Orchestrator\n");
});

orchServer.on("upgrade", (req, socket, head) => {
    handleUpgrade(req, socket, head, "orchestrator");
});

orchServer.listen(ORCHESTRATOR_PORT, () => {
    log("BRIDGE", `orchestrator server listening on :${ORCHESTRATOR_PORT}`);
});

process.on("uncaughtException", (e) => log("ERR", e.stack ?? e.message));
