const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const PORT = 4000;

const app = express();
app.use(cors());

const pool = new Pool({
  user: 'njabulonxumalo',
  host: 'localhost',
  database: 'fika',
  port: 5432,
});

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

function handleQueryError(res, error) {
  console.error('Error executing query', error);
  res.status(500).json({ error: 'Internal Server Error' });
}

app.get('/schedules', async (req, res) => {
  try {
    const { rows } = await pool.query(schedulesQuery);
    res.json(rows);
  } catch (error) {
    handleQueryError(res, error);
  }
});

app.get('/schedule_times/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await pool.query(scheduleTimesQuery, [id]);
    res.json(rows);
  } catch (error) {
    handleQueryError(res, error);
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
