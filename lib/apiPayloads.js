const SERVICE_DAY_KEYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'public_holiday',
];

const schedulesQuery = `
  SELECT
    routes.id,
    routes.name,
    routes.code,
    routes.agency,
    MAX(CASE WHEN directions.row_num = 1 THEN directions.direction END) AS direction_1,
    MAX(CASE WHEN directions.row_num = 2 THEN directions.direction END) AS direction_2
  FROM routes
  JOIN (
    SELECT
      direction,
      route_id,
      ROW_NUMBER() OVER (PARTITION BY route_id ORDER BY direction) AS row_num
    FROM directions
  ) AS directions ON routes.id = directions.route_id
  WHERE routes.name != ''
  GROUP BY routes.id, routes.name, routes.code, routes.agency
  ORDER BY routes.agency, routes.name, routes.id;
`;

const routeByIdQuery = `
  SELECT
    routes.id,
    routes.name,
    routes.code,
    routes.agency,
    MAX(CASE WHEN directions.row_num = 1 THEN directions.direction END) AS direction_1,
    MAX(CASE WHEN directions.row_num = 2 THEN directions.direction END) AS direction_2
  FROM routes
  JOIN (
    SELECT
      direction,
      route_id,
      ROW_NUMBER() OVER (PARTITION BY route_id ORDER BY direction) AS row_num
    FROM directions
  ) AS directions ON routes.id = directions.route_id
  WHERE routes.name != ''
    AND routes.id = $1
  GROUP BY routes.id, routes.name, routes.code, routes.agency
  LIMIT 1;
`;

const scheduleTimesQuery = `
  WITH route_stop_times AS (
    SELECT
      stops.name,
      directions.direction AS direction_name,
      directions.id AS directions_id,
      stop_times.sequence,
      trips.id AS trip_id,
      stop_times.arrival,
      stop_times.stop_time_type,
      trips.monday,
      trips.tuesday,
      trips.wednesday,
      trips.thursday,
      trips.friday,
      trips.saturday,
      trips.sunday,
      trips.public_holiday,
      CONCAT(
        trips.monday::int,
        trips.tuesday::int,
        trips.wednesday::int,
        trips.thursday::int,
        trips.friday::int,
        trips.saturday::int,
        trips.sunday::int,
        trips.public_holiday::int
      ) AS service_pattern,
      MIN(stop_times.arrival) OVER (PARTITION BY trips.id) AS first_arrival
    FROM directions
    JOIN trips ON trips.direction_id = directions.id
    JOIN stop_times ON stop_times.trip_id = trips.id
    JOIN stops ON stops.id = stop_times.stop_id
    WHERE directions.route_id = $1
  )

  SELECT
    name,
    direction_name,
    directions_id,
    sequence,
    JSON_AGG(
      JSON_BUILD_OBJECT(
        'trip_id', trip_id,
        'arrival', arrival,
        'stop_time_type', stop_time_type,
        'monday', monday,
        'tuesday', tuesday,
        'wednesday', wednesday,
        'thursday', thursday,
        'friday', friday,
        'saturday', saturday,
        'sunday', sunday,
        'public_holiday', public_holiday,
        'service_pattern', service_pattern,
        'first_arrival', first_arrival
      )
      ORDER BY service_pattern DESC, first_arrival, trip_id
    ) AS stop_times
  FROM route_stop_times
  GROUP BY directions_id, direction_name, sequence, name
  ORDER BY directions_id, sequence;
`;

function normalizeTimeValue(value) {
  return value == null ? null : String(value);
}

function compareTrips(firstTrip, secondTrip) {
  const firstPattern = firstTrip.service_pattern || '';
  const secondPattern = secondTrip.service_pattern || '';
  const patternComparison = secondPattern.localeCompare(firstPattern);

  if (patternComparison !== 0) {
    return patternComparison;
  }

  const firstArrival = firstTrip.first_arrival || '';
  const secondArrival = secondTrip.first_arrival || '';
  const arrivalComparison = firstArrival.localeCompare(secondArrival);

  if (arrivalComparison !== 0) {
    return arrivalComparison;
  }

  return Number(firstTrip.trip_id) - Number(secondTrip.trip_id);
}

function compareRows(firstRow, secondRow) {
  const firstSequence = Number(firstRow.sequence) || 0;
  const secondSequence = Number(secondRow.sequence) || 0;

  return firstSequence - secondSequence || String(firstRow.name).localeCompare(String(secondRow.name));
}

function getOrCreateDirection(directionMap, row) {
  const directionId = row.directions_id == null ? null : Number(row.directions_id);
  const directionName = row.direction_name || '';
  const directionKey = directionId == null ? directionName : String(directionId);

  if (!directionMap.has(directionKey)) {
    directionMap.set(directionKey, {
      id: directionId,
      name: directionName,
      trips: [],
      rows: [],
      tripById: new Map(),
    });
  }

  return directionMap.get(directionKey);
}

function getTripMetadata(stopTime) {
  const trip = {
    trip_id: Number(stopTime.trip_id),
    service_pattern: stopTime.service_pattern || '',
    first_arrival: normalizeTimeValue(stopTime.first_arrival),
  };

  SERVICE_DAY_KEYS.forEach((key) => {
    if (stopTime[key]) {
      trip[key] = true;
    }
  });

  return trip;
}

function getStopTimeCell(stopTime) {
  const cell = {
    trip_id: Number(stopTime.trip_id),
  };
  const arrival = normalizeTimeValue(stopTime.arrival);

  if (arrival) {
    cell.arrival = arrival;
  }

  if (stopTime.stop_time_type) {
    cell.stop_time_type = stopTime.stop_time_type;
  }

  return cell;
}

function buildNormalizedTimetablePayload(routeId, rows) {
  const directionMap = new Map();

  (rows || []).forEach((row) => {
    const direction = getOrCreateDirection(directionMap, row);
    const stopTimes = Array.isArray(row.stop_times) ? row.stop_times : [];

    const cells = stopTimes.map((stopTime) => {
      const tripId = Number(stopTime.trip_id);

      if (!direction.tripById.has(tripId)) {
        direction.tripById.set(tripId, getTripMetadata(stopTime));
      }

      return getStopTimeCell(stopTime);
    });

    direction.rows.push({
      name: row.name || '',
      sequence: Number(row.sequence) || 0,
      stop_times: cells,
    });
  });

  return {
    version: 2,
    route_id: Number(routeId),
    directions: [...directionMap.values()].map((direction) => ({
      id: direction.id,
      name: direction.name,
      trips: [...direction.tripById.values()].sort(compareTrips),
      rows: direction.rows.sort(compareRows),
    })),
  };
}

module.exports = {
  buildNormalizedTimetablePayload,
  routeByIdQuery,
  scheduleTimesQuery,
  schedulesQuery,
};
