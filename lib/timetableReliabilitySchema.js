const fs = require('fs');
const path = require('path');

const TIMETABLE_RELIABILITY_SCHEMA_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'timetable_reliability.sql'),
  'utf8'
);

const readyDatabases = new WeakSet();
const setupPromises = new WeakMap();

async function ensureTimetableReliabilitySchema(database) {
  if (readyDatabases.has(database)) {
    return;
  }

  if (!setupPromises.has(database)) {
    const setupPromise = database.query("SELECT version FROM fika_schema_versions WHERE name='timetable_publication' AND version>=1")
      .then(result => {
        if (!result.rows.length) throw new Error('Run npm run migrate:timetables before starting this service.');
      })
      .then(() => {
        readyDatabases.add(database);
      })
      .finally(() => {
        setupPromises.delete(database);
      });
    setupPromises.set(database, setupPromise);
  }

  await setupPromises.get(database);
}

module.exports = {
  TIMETABLE_RELIABILITY_SCHEMA_SQL,
  ensureTimetableReliabilitySchema,
};
