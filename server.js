const path = require('path');
const backendPath = './apps/api/dist/apps/api/src/index.js';

// CATCH ALL REAL BACKEND CRASHES
process.on('uncaughtException', (err) => {
    console.error("🔥 REAL BACKEND ERROR:", err.message);
    console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
    console.error("🔥 REAL REJECTION:", reason);
});

// PEM FIX (Keep this)
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

console.log("--- PROXY STARTING (STABLE VERSION) ---");

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
