console.log("--- PROXY STARTING ---");
const path = require('path');
const backendPath = './apps/api/dist/apps/api/src/index.js';

async function start() {
    console.log("Loading backend...");
    try {
        const backend = require(backendPath);
        console.log("Backend loaded. Export keys:", Object.keys(backend));
        
        if (typeof backend === 'function') {
            await backend();
        } else if (backend.default) {
            await backend.default();
        }
        
        console.log("--- BACKEND START COMMAND ISSUED ---");
    } catch (e) {
        console.error("LOAD ERROR:", e);
    }
}

// THIS KEEPS THE PROCESS ALIVE NO MATTER WHAT
setInterval(() => {
    console.log("Keeping process alive... " + new Date().toISOString());
}, 30000);

start();
