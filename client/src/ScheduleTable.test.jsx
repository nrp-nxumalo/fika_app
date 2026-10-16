import React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, within } from '@testing-library/react';
import ScheduleTable from './ScheduleTable';
import { getTripDetails, getVisibleTrips, getServiceBadge, normalizeStopName } from './tripListUtils';

const route = { id: 98, agency: 'GABS', code: '0098', name: 'Bluedowns - Cape Town', direction_1: 'Bluedowns - Mowbray - Cape Town', direction_2: 'Cape Town - Mowbray - Bluedowns' };
const trips = [
  { trip_id: 2, monday: true, tuesday: true, wednesday: true, thursday: true, friday: true },
  { trip_id: 1, monday: true, tuesday: true, wednesday: true, thursday: true },
  { trip_id: 3, friday: true },
  { trip_id: 4, saturday: true },
  { trip_id: 5, public_holiday: true },
];
const cell = (trip_id, arrival, stop_time_type = 'scheduled') => ({ trip_id, arrival, stop_time_type });
const rows = [
  { name: 'Not served', sequence: 0, stop_times: trips.map(t => cell(t.trip_id, null, 'not_served')) },
  { name: 'Electric City', sequence: 1, stop_times: [cell(1, '05:00:00'), cell(2, '05:00:00'), cell(3, '07:00:00'), cell(4, '06:00:00'), cell(5, '09:00:00')] },
  { name: 'Mowbray', sequence: 2, stop_times: [cell(1, null, 'via'), cell(2, '05:30:00'), cell(3, '07:30:00')] },
  { name: 'Waterfront', sequence: 3, stop_times: [cell(1, '06:15:00')] },
  { name: 'Cape Town', sequence: 3, stop_times: [cell(2, '06:00:00'), cell(3, '08:00:00'), cell(4, '07:00:00'), cell(5, '10:00:00')] },
];
const scheduleData = Object.fromEntries([route.direction_1, route.direction_2].map(name => [name, { name, trips, rows }]));
const props = { route, scheduleData, selectedDirection: route.direction_1, selectedServiceDay: 'monday' };
const tripButtons = () => screen.queryAllByRole('button', { name: /(?:Show|Hide) stops/ });

test('shows compact chronological journeys, preserving simultaneous branches and selected direction', () => {
  render(<ScheduleTable {...props} />);
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('→ Cape Town');
  expect(screen.getByText('via Mowbray')).toBeInTheDocument();
  expect(screen.getByText('Golden Arrow · 0098 · Bluedowns–Cape Town')).toBeInTheDocument();
  expect(tripButtons()).toHaveLength(2);
  expect(tripButtons()[0]).toHaveTextContent('05:00Electric CityArrives06:15WaterfrontDuration1 hr 15 min');
  expect(tripButtons()[1]).toHaveTextContent('05:00Electric CityArrives06:00Cape TownDuration1 hr');
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Trip stops and times' })).not.toBeInTheDocument();
});

test('expands trips independently, omits unserved stops, explains via and preserves focus when collapsing', () => {
  render(<ScheduleTable {...props} />);
  const first = tripButtons()[0], second = tripButtons()[1];
  first.focus();
  fireEvent.click(first);
  fireEvent.click(second);
  expect(first).toHaveAttribute('aria-expanded', 'true');
  expect(second).toHaveAttribute('aria-expanded', 'true');
  const timelines = screen.getAllByRole('list', { name: 'Trip stops and times' });
  expect(timelines).toHaveLength(2);
  expect(timelines[0]).toHaveTextContent('Via · time not published');
  expect(timelines[0]).not.toHaveTextContent('Not served');
  expect(timelines[0]).not.toHaveTextContent('Cape Town');
  expect(screen.getByText('Runs Mon–Thu.')).toBeVisible();
  fireEvent.click(first);
  expect(first).toHaveFocus();
  expect(first).toHaveAttribute('aria-expanded', 'false');
  expect(second).toHaveAttribute('aria-expanded', 'true');
});

test('boarding filtering shows the selected stop time, remaining duration and a separate untimed group', () => {
  render(<ScheduleTable {...props} />);
  fireEvent.change(screen.getByLabelText('Boarding at'), { target: { value: 'mowbray' } });
  expect(tripButtons()).toHaveLength(2);
  expect(tripButtons()[0]).toHaveTextContent('05:30MowbrayArrives06:00Cape TownDuration30 min');
  const untimed = screen.getByRole('region', { name: 'No published boarding time' });
  expect(within(untimed).getByRole('button')).toHaveTextContent('Time not publishedMowbray');
  expect(within(untimed).getByRole('button')).toHaveTextContent('Not available');
  fireEvent.click(tripButtons()[0]);
  const timeline = screen.getByRole('list', { name: 'Trip stops and times' });
  expect(timeline).toHaveTextContent('Electric City');
  expect(timeline).toHaveTextContent('Selected stop');
  fireEvent.change(screen.getByLabelText('Boarding at'), { target: { value: 'waterfront' } });
  expect(tripButtons()).toHaveLength(1);
});

test('preserves a boarding stop on compatible days and resets it on missing days, direction or route changes', () => {
  const { rerender } = render(<ScheduleTable {...props} />);
  fireEvent.change(screen.getByLabelText('Boarding at'), { target: { value: 'mowbray' } });
  rerender(<ScheduleTable {...props} selectedServiceDay="friday" />);
  expect(screen.getByLabelText('Boarding at')).toHaveValue('mowbray');
  rerender(<ScheduleTable {...props} selectedServiceDay="saturday" />);
  expect(screen.getByLabelText('Boarding at')).toHaveValue('');
  expect(screen.getByRole('status')).toHaveTextContent('not listed on this day');
  rerender(<ScheduleTable {...props} />);
  fireEvent.change(screen.getByLabelText('Boarding at'), { target: { value: 'mowbray' } });
  rerender(<ScheduleTable {...props} selectedDirection={route.direction_2} />);
  expect(screen.getByLabelText('Boarding at')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('Boarding at'), { target: { value: 'mowbray' } });
  rerender(<ScheduleTable {...props} route={{ ...route, id: 99 }} selectedDirection={route.direction_2} />);
  expect(screen.getByLabelText('Boarding at')).toHaveValue('');
});

test('service-day flags select Friday, Saturday and holiday journeys without mixing row vectors', () => {
  expect(getVisibleTrips(trips, 'friday', rows).map(t => t.trip_id)).toEqual([2, 3]);
  expect(getVisibleTrips(trips, 'saturday', rows).map(t => t.trip_id)).toEqual([4]);
  expect(getVisibleTrips(trips, 'public_holiday', rows).map(t => t.trip_id)).toEqual([5]);
  const { rerender } = render(<ScheduleTable {...props} selectedServiceDay="sunday" />);
  expect(screen.getByText('No trips listed for Sunday')).toBeInTheDocument();
  expect(tripButtons()).toHaveLength(0);
  rerender(<ScheduleTable {...props} selectedServiceDay="" />);
  expect(screen.getByText('Choose a service day')).toBeInTheDocument();
  expect(tripButtons()).toHaveLength(0);
  rerender(<ScheduleTable {...props} selectedServiceDay="public_holiday" />);
  fireEvent.click(tripButtons()[0]);
  expect(screen.getByText('Runs Public Holiday.')).toBeVisible();
  expect(getServiceBadge({ monday: true, tuesday: true, thursday: true, public_holiday: true })).toBe('Mon–Tue, Thu, Public Holiday');
});

test('overnight journeys retain stop sequence, calculate elapsed time and label next-day times', () => {
  const overnight = [{ trip_id: 10, monday: true }];
  const nightRows = [
    { name: 'Origin', sequence: 0, stop_times: [cell(10, '23:50:00')] },
    { name: 'Middle', sequence: 1, stop_times: [cell(10, '00:10:00')] },
    { name: 'Destination', sequence: 2, stop_times: [cell(10, '00:25:00')] },
  ];
  expect(getTripDetails(overnight[0], nightRows).durationMinutes).toBe(35);
  expect(getTripDetails(overnight[0], nightRows, 'middle').durationMinutes).toBe(15);
  render(<ScheduleTable {...props} scheduleData={{ [route.direction_1]: { trips: overnight, rows: nightRows } }} />);
  expect(tripButtons()[0]).toHaveTextContent('00:25Next day');
  expect(tripButtons()[0]).toHaveTextContent('35 min');
});

test('does not replace an untimed endpoint with an intermediate time or claim a duration', () => {
  const partialRows = [
    { name: 'Start', sequence: 0, stop_times: [cell(1, null, 'via')] },
    { name: 'First timing point', sequence: 1, stop_times: [cell(1, '08:00:00')] },
    { name: 'Last timing point', sequence: 2, stop_times: [cell(1, '09:00:00')] },
    { name: 'Destination', sequence: 3, stop_times: [cell(1, null, 'scheduled')] },
  ];
  const details = getTripDetails(trips[1], partialRows);
  expect(details.firstStop.name).toBe('Start');
  expect(details.lastStop.name).toBe('Destination');
  expect(details.departureMinutes).toBeNull();
  expect(details.arrivalMinutes).toBeNull();
  expect(details.durationMinutes).toBeNull();
});

test('explains inconsistent published times without removing loop visits or adding days', () => {
  const loopRows = [
    { name: 'Start', sequence: 1, stop_times: [cell(1, '22:40:00')] },
    { name: 'Loop stop', sequence: 2, stop_times: [cell(1, '22:45:00')] },
    { name: 'Turnaround', sequence: 3, stop_times: [cell(1, '22:50:00')] },
    { name: 'Loop stop', sequence: 4, stop_times: [cell(1, '22:45:00')] },
    { name: 'Crown', sequence: 5, stop_times: [cell(1, '23:06:00')] },
  ];
  render(<ScheduleTable {...props} scheduleData={{ [route.direction_1]: { trips: [trips[1]], rows: loopRows } }} />);
  expect(tripButtons()[0]).toHaveTextContent('Duration26 min');
  fireEvent.click(tripButtons()[0]);
  expect(screen.getByText(/Some published stop times are out of order/)).toBeVisible();
  expect(screen.getByText('Published time needs checking')).toBeVisible();
  expect(within(screen.getByRole('list', { name: 'Trip stops and times' })).getAllByRole('listitem')).toHaveLength(5);
  expect(screen.queryByText('Next day')).not.toBeInTheDocument();
});

test('merges stop names across row sequences without mixing individual journeys', () => {
  const repeated = [...rows, { name: '  MOWBRAY  ', sequence: 4, stop_times: [cell(4, '06:30:00')] }];
  const allMonday = trips.map(t => ({ ...t, monday: true }));
  render(<ScheduleTable {...props} scheduleData={{ [route.direction_1]: { trips: allMonday, rows: repeated } }} />);
  expect(within(screen.getByLabelText('Boarding at')).getAllByRole('option', { name: /mowbray/i })).toHaveLength(1);
  expect(normalizeStopName('  MOWBRAY  ')).toBe('mowbray');
});
