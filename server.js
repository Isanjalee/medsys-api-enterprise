const path = require('path');
const backendPath = './apps/api/dist/apps/api/src/index.js';

// --- LOG EVERY REQUEST ---
const http = require('http');
const oldCreateServer = http.createServer;
http.createServer = function(handler) {
    return oldCreateServer.call(this, (req, res) => {
        console.log(`>>> HIT RECEIVED: ${req.method} ${req.url} from ${req.headers['x-forwarded-for'] || req.connection.remoteAddress}`);
        return handler(req, res);
    });
};

// ... (Keep the PEM fix logic from before) ...
function fixPem(key) {
    if (!key || key.includes('\n')) return key;
    return key.replace(/-----BEGIN [A-Z ]+-----/, "$&\n")
              .replace(/-----END [A-Z ]+-----/, "\n$&")
              .replace(/([^\n]{64})/g, "$1\n");
}
process.env.JWT_ACCESS_PRIVATE_KEY = fixPem(process.env.JWT_ACCESS_PRIVATE_KEY);
process.env.JWT_ACCESS_PUBLIC_KEY = fixPem(process.env.JWT_ACCESS_PUBLIC_KEY);
process.env.JWT_REFRESH_PRIVATE_KEY = fixPem(process.env.JWT_REFRESH_PRIVATE_KEY);
process.env.JWT_REFRESH_PUBLIC_KEY = fixPem(process.env.JWT_REFRESH_PUBLIC_KEY);

console.log("--- PROXY STARTING (TRAFFIC MONITOR ON) ---");

async function start() {
    try {
        require(backendPath);
        console.log("Backend required.");
    } catch (e) {
        console.error("REQUIRE ERROR:", e);
    }
}
setInterval(() => { console.log("Heartbeat..."); }, 30000);
start();
