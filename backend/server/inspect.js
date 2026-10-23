const fs = require('fs');
const path = require('path');
const root = 'c:/Users/LeathLOQ/Desktop/LEADAI/LeadAI/backend/server';
const src = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const a = src.indexOf('export { app');
console.log('pos', a);
console.log('len', src.length);
console.log('export_list', src.slice(a, a + 80));
