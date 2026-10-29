const DAYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday','public_holiday'];
const BATCH_SIZE = 200;

async function resolveStops(client, operator, trips, stopIds) {
  const names = [...new Set(trips.flatMap(trip => trip.times.map(time => time.stop_name)))]
    .filter(name => !stopIds.has(`${operator}\0${name}`));
  if (!names.length) return;
  // Publication is serialized by the existing publication lock. Preserve the
  // oldest ID when historical imports left duplicate names.
  const existing = await client.query(`SELECT id, name FROM stops
    WHERE agency=$1 AND name=ANY($2::text[]) ORDER BY id;`, [operator, names]);
  for (const row of existing.rows) {
    const key = `${operator}\0${row.name}`;
    if (!stopIds.has(key)) stopIds.set(key, row.id);
  }
  const missing = names.filter(name => !stopIds.has(`${operator}\0${name}`));
  if (missing.length) {
    const inserted = await client.query(`INSERT INTO stops(name,agency)
      SELECT name,$1 FROM unnest($2::text[]) AS name RETURNING id,name;`, [operator, missing]);
    for (const row of inserted.rows) stopIds.set(`${operator}\0${row.name}`, row.id);
  }
  if (names.some(name => !stopIds.has(`${operator}\0${name}`))) throw new Error('Unable to resolve timetable stops.');
}

async function createTripsWithStopTimes(client, directionId, trips, operator, stopIds, provenance) {
  for (let offset = 0; offset < trips.length; offset += BATCH_SIZE) {
    const batch = trips.slice(offset, offset + BATCH_SIZE);
    await resolveStops(client, operator, batch, stopIds);
    const records = batch.map(trip => ({
      ...Object.fromEntries(DAYS.map(day => [day, trip.serviceDays.includes(day)])),
      ordinal: trip.tripOrdinal,
    }));
    const inserted = await client.query(`INSERT INTO trips (
      direction_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, public_holiday,
      timetable_source_id,timetable_source_version_id,timetable_effective_date,
      timetable_service_family,timetable_trip_ordinal,timetable_section_version_id)
      SELECT $2, monday,tuesday,wednesday,thursday,friday,saturday,sunday,public_holiday,
        $3,$4,$5::date,$6,ordinal,$7
      FROM jsonb_to_recordset($1::jsonb) AS t(monday boolean,tuesday boolean,wednesday boolean,
        thursday boolean,friday boolean,saturday boolean,sunday boolean,public_holiday boolean,ordinal integer)
      RETURNING id,timetable_trip_ordinal;`, [JSON.stringify(records), directionId,
      provenance.sourceId || null, provenance.versionId || null, provenance.effectiveDate || null,
      provenance.family || null, provenance.sectionVersionId || null]);
    // RETURNING order is unspecified; match each trip by its canonical ordinal.
    const ids = new Map(inserted.rows.map(row => [Number(row.timetable_trip_ordinal), row.id]));
    if (ids.size !== batch.length || batch.some(trip => !ids.has(trip.tripOrdinal))) {
      throw new Error('Unable to map published trip ordinals.');
    }
    const times = batch.flatMap(trip => trip.times.map(time => ({
      trip_id: ids.get(trip.tripOrdinal), sequence: time.sequence, departure: time.time, arrival: time.time,
      stop_id: stopIds.get(`${operator}\0${time.stop_name}`), stop_time_type: time.stop_time_type,
    })));
    await client.query(`INSERT INTO stop_times (sequence,departure,arrival,stop_id,trip_id,stop_time_type)
      SELECT sequence,departure,arrival,stop_id,trip_id,stop_time_type
      FROM jsonb_to_recordset($1::jsonb) AS t(sequence integer,departure time,arrival time,
        stop_id integer,trip_id integer,stop_time_type text);`, [JSON.stringify(times)]);
  }
}

module.exports = { createTripsWithStopTimes, BATCH_SIZE };
