const db = require('better-sqlite3')('C:/Users/molyndon/Documents/projects/ai-receptionist/data/receptionist.db');

const calls = db.prepare(`
  SELECT 
    c.created_at,
    c.phone_from,
    c.duration_seconds,
    c.turn_count,
    c.transcript
  FROM calls c
  ORDER BY c.created_at DESC
  LIMIT 5
`).all();

console.log(JSON.stringify(calls, null, 2));
