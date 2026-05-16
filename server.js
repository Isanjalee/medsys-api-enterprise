const path = require('path');
console.log("--- PROXY STARTING ---");
console.log("Current Directory:", __dirname);

// This goes up one level and then into public_html where the build is
const backendPath = path.join(__dirname, '..', 'public_html', 'apps', 'api', 'dist', 'index.js');

try {
    console.log("Attempting to load backend from:", backendPath);
    require(backendPath);
    console.log("--- BACKEND LOADED SUCCESSFULLY ---");
} catch (err) {
    console.error("!!! CRITICAL ERROR STARTING BACKEND !!!");
    console.error(err);
    process.exit(1);
}
