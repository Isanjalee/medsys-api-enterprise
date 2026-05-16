const path = require('path');
const backendPath = './apps/api/dist/apps/api/src/index.js';

process.on('uncaughtException', (err) => {
    console.error('!!! UNCAUGHT EXCEPTION !!!');
    console.error(err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('!!! UNHANDLED REJECTION !!!');
    console.error(reason);
});

console.log("--- PROXY STARTING ---");

async function start() {
    try {
        console.log("Requiring backend...");
        require(backendPath);
        console.log("Backend required.");
    } catch (e) {
        console.error("REQUIRE ERROR:", e);
    }
}

// Keep-alive loop
setInterval(() => {
    console.log("Process heartbeat: " + new Date().toISOString());
}, 10000);

start();
