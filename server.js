const fs = require('fs');
const path = require('path');

console.log("--- DIRECTORY SEARCH ---");
console.log("Current Dir (__dirname):", __dirname);

try {
    const root = path.join(__dirname, '..');
    console.log("Root Folders:", fs.readdirSync(root));
    
    // Check if there is a .builds folder or similar
    if (fs.existsSync(path.join(root, 'public_html'))) {
        console.log("Inside public_html:", fs.readdirSync(path.join(root, 'public_html')));
    }
} catch (err) {
    console.error("Search failed:", err);
}

// Keep the old try-catch here so it still tries to run
try {
    const backendPath = path.join(__dirname, '..', 'public_html', 'apps', 'api', 'dist', 'index.js');
    require(backendPath);
} catch (e) {}
