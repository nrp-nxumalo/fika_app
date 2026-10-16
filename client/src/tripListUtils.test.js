import { formatDayOffset, getTripDetails, getVisibleTrips } from './tripListUtils';

const trip = { trip_id: 4190, monday: true };
const makeRows = (visits, tripId = trip.trip_id) => visits.map(([name, arrival], sequence) => ({
  name, sequence, stop_times: [{ trip_id: tripId, arrival, stop_time_type: 'scheduled' }],
}));

// The archived MyCiTi 243 PDF and the published database both contain these
// repeated early times at the second visit to each Pella loop stop.
const crownVisits = [
  ['Atlantis Station', '22:35:00'], ['Arion', '22:38:00'], ['Charel Uys North', '22:40:00'],
  ['Montreal', '22:42:00'], ['Tsitsikamma', '22:43:00'], ['Atlantis Cemetery', '22:45:00'],
  ['Pella South', '22:47:00'], ['Pella Central', '22:48:00'], ['Pella North', '22:49:00'],
  ['Pella Central', '22:48:00'], ['Pella South', '22:47:00'], ['Atlantis Cemetery', '22:45:00'],
  ['Frans', '22:56:00'], ['Denne East', '22:57:00'], ['Denne West', '22:58:00'],
  ['Lord Caledon', '22:59:00'], ['Enon', '22:59:00'], ['Goedverwacht', '22:59:00'],
  ['Paradise', '23:00:00'], ['Crown', '23:01:00'],
];

test('retains route 243 loop visits without turning repeated PDF times into three extra days', () => {
  const details = getTripDetails(trip, makeRows(crownVisits));
  expect(details.stops.map(stop => [stop.name, stop.arrival])).toEqual(crownVisits);
  expect(details.stops).toHaveLength(20);
  expect(details.stops.filter(stop => stop.timingIssue).map(stop => stop.sequence)).toEqual([9, 10, 11]);
  expect(details.hasTimingIssues).toBe(true);
  expect(details.durationMinutes).toBe(26);
  expect(details.stops.every(stop => formatDayOffset(stop.minutes) === '')).toBe(true);
  expect(getTripDetails(trip, makeRows(crownVisits), 'pella north').durationMinutes).toBe(12);
});

test('retains legitimate return visits when each occurrence has its own published time', () => {
  const visits = crownVisits.map(visit => [...visit]);
  visits[9][1] = '22:51:00';
  visits[10][1] = '22:53:00';
  visits[11][1] = '22:55:00';
  const details = getTripDetails(trip, makeRows(visits));
  expect(details.stops.filter(stop => stop.name === 'Pella Central').map(stop => stop.minutes)).toEqual([1368, 1371]);
  expect(details.hasTimingIssues).toBe(false);
  expect(details.durationMinutes).toBe(26);
});

test('infers a real midnight crossing once, including when an intermediate source time regresses', () => {
  const details = getTripDetails(trip, makeRows([
    ['Origin', '23:50:00'], ['Middle', '00:10:00'], ['Incorrect source time', '00:05:00'], ['Destination', '00:25:00'],
  ]));
  expect(details.stops.map(stop => stop.minutes)).toEqual([1430, 1450, 1445, 1465]);
  expect(details.stops.map(stop => stop.timingIssue)).toEqual([false, false, true, false]);
  expect(details.durationMinutes).toBe(35);
  expect(formatDayOffset(details.arrivalMinutes)).toBe('Next day');
  expect(getTripDetails(trip, makeRows([
    ['Origin', '23:50:00'], ['Middle', '00:10:00'], ['Destination', '00:25:00'],
  ]), 'middle').durationMinutes).toBe(15);
});

test('honours explicit after-midnight hours and does not invent a day for a reversed endpoint', () => {
  const explicit = getTripDetails(trip, makeRows([
    ['Origin', '23:50:00'], ['Middle', '24:10:00'], ['Destination', '24:25:00'],
  ]));
  expect(explicit.durationMinutes).toBe(35);
  expect(explicit.hasTimingIssues).toBe(false);
  const reversed = getTripDetails(trip, makeRows([['Origin', '09:00:00'], ['Destination', '08:55:00']]));
  expect(reversed.durationMinutes).toBeNull();
  expect(reversed.hasTimingIssues).toBe(true);
  expect(formatDayOffset(reversed.arrivalMinutes)).toBe('');
});

test('source inconsistency handling does not merge simultaneous trips or service-day branches', () => {
  const otherTrip = { trip_id: 4191, monday: true };
  const saturday = { trip_id: 4192, saturday: true };
  const rows = [
    ...makeRows(crownVisits),
    ...makeRows([['Atlantis Station', '22:35:00'], ['Different branch', '22:45:00']], otherTrip.trip_id),
    ...makeRows([['Weekend start', '06:00:00'], ['Crown', '06:30:00']], saturday.trip_id),
  ];
  const monday = getVisibleTrips([trip, otherTrip, saturday], 'monday', rows);
  expect(monday.map(item => item.trip_id)).toEqual([4190, 4191]);
  expect(monday.map(item => item.details.lastStop.name)).toEqual(['Crown', 'Different branch']);
  expect(getVisibleTrips([trip, otherTrip, saturday], 'saturday', rows).map(item => item.trip_id)).toEqual([4192]);
});
