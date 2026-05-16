console.log("--- PROXY STARTING ---");
try {
    console.log("Attempting to load backend from ./apps/api/dist/index.js");
    require('./apps/api/dist/index.js');
    console.log("--- BACKEND LOADED SUCCESSFULLY ---");
} catch (err) {
    console.error("!!! CRITICAL ERROR STARTING BACKEND !!!");
    console.error(err);
    process.exit(1);
}
