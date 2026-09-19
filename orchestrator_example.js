/**
 * Пример оркестратора — отправляет команды устройствам через bridge.
 * Запуск: node orchestrator_example.js
 *
 * Используй этот паттерн в своём LLM-агенте / Python-скрипте (через WebSocket).
 */

const WebSocket = require("ws");

const BRIDGE_HOST = "31.76.87.43";  // ← сменить на IP вашего ВПС
const ORCH_PORT   = 7335;

const ws = new WebSocket(`ws://${BRIDGE_HOST}:${ORCH_PORT}`);

ws.on("open", async () => {
    console.log("Connected to bridge");

    // 1. Список подключённых устройств
    send({ type: "list_devices" });

    // Подождать ответа и отправить команду
    // (в реальном агенте используй Promise + message handler)
});

ws.on("message", (data) => {
    const msg = JSON.parse(data);

    if (msg.devices) {
        console.log("Devices:", JSON.stringify(msg.devices, null, 2));
        if (msg.devices.length === 0) { console.log("No devices connected"); return; }

        const deviceId = msg.devices[0].device_id;
        console.log(`\nSending get_screen to ${deviceId}...`);

        // 2. Получить дерево экрана
        send({
            type:      "command",
            device_id: deviceId,
            command:   { type: "get_screen", compact: true },
        });

        return;
    }

    if (msg.result) {
        console.log("Result:", JSON.stringify(msg.result, null, 2));
    }
    if (msg.error) {
        console.log("Error:", msg.error);
    }
});

ws.on("error", (e) => console.error("WS error:", e.message));
ws.on("close", () => console.log("Disconnected"));

function send(obj) {
    ws.send(JSON.stringify(obj));
}

/**
 * Команды которые поддерживает устройство:
 *
 * get_screen:   { type: "get_screen", compact: true }
 * screenshot:   { type: "screenshot", max_dim: 1080, quality: 70 }
 * click:        { type: "click", text: "Search", desc: "", id: "" }
 * tap:          { type: "tap", x: 540, y: 960 }
 * input_text:   { type: "input_text", text: "hello", id: "" }
 * scroll:       { type: "scroll", direction: "down", duration: 300 }
 * open_url:     { type: "open_url", url: "https://google.com" }
 * launch_app:   { type: "launch_app", package: "com.instagram.android" }
 * list_packages:{ type: "list_packages", system: true, launchable_only: false }
 * back:         { type: "back" }
 * home:         { type: "home" }
 * notifications:{ type: "notifications" }
 * enter:        { type: "enter" }
 * ping:         { type: "ping" }
 * network_speed:{ type: "network_speed" }
 */
