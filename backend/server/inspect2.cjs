const fs = require('fs');
const path = require('path');
const root = 'c:/Users/LeathLOQ/Desktop/LEADAI/LeadAI/backend/server';
const src = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const i = src.indexOf('findTeamForMembership');
console.log('idx', i);
console.log(src.slice(i - 120, i + 80));
