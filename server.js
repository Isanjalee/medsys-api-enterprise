const http = require('http');
const net = require('net');
const backendPath = './apps/api/dist/apps/api/src/index.js';

// CATCH ALL CRASHES
process.on('uncaughtException', (err) => {
    console.error("🔥 CRASH DETECTED:", err.message);
    console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
    console.error("🔥 REJECTION DETECTED:", reason);
});

function testPort() {
    const client = new net.Socket();
    client.setTimeout(5000);
    client.connect(5432, 'ep-autumn-moon-aqy6mguf.c-8.us-east-1.aws.neon.tech', () => {
        console.log("✅ DB PORT OPEN");
        client.destroy();
    });
    client.on('error', (err) => console.error("❌ DB PORT CLOSED:", err.message));
}

const oldCreateServer = http.createServer;
http.createServer = function(handler) {
    return oldCreateServer.call(this, (req, res) => {
        console.log(`>>> HIT: ${req.method} ${req.url}`);
        return handler(req, res);
    });
};

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

console.log("--- PROXY STARTING ---");
testPort();

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
