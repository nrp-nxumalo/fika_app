import React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render } from '@testing-library/react';
import ScheduleTable, { getTripDetails, getVisibleRows, getVisibleTrips } from './ScheduleTable';

const weekdayTrip = {
  trip_id: 101,
  monday: true,
  service_pattern: '11111000',
  first_arrival: '04:50:00',
};

const saturdayTrip = {
  trip_id: 202,
  saturday: true,
  service_pattern: '00000100',
  first_arrival: '06:00:00',
};

const rows = [
  {
    name: 'MAKHAZA',
    sequence: 0,
    stop_times: [
      { trip_id: 101, stop_time_type: 'not_served' },
      { trip_id: 202, arrival: '06:00:00', stop_time_type: 'scheduled' },
    ],
  },
  {
    name: 'MAKHAYA',
    sequence: 1,
    stop_times: [{ trip_id: 101, stop_time_type: 'not_served' }],
  },
  {
    name: 'VILLAGE 3',
    sequence: 1,
    stop_times: [{ trip_id: 202, arrival: '06:20:00', stop_time_type: 'scheduled' }],
  },
  {
    name: 'VILLAGE 3',
    sequence: 2,
    stop_times: [{ trip_id: 101, stop_time_type: 'not_served' }],
  },
  {
    name: 'HARARE',
    sequence: 2,
    stop_times: [{ trip_id: 202, arrival: '06:30:00', stop_time_type: 'scheduled' }],
  },
  {
    name: 'HARARE',
    sequence: 3,
    stop_times: [{ trip_id: 101, arrival: '04:50:00', stop_time_type: 'scheduled' }],
  },
];

test('visible rows include only rows used by the selected service-day trips', () => {
  expect(getVisibleRows(rows, [weekdayTrip]).map((row) => row.name)).toEqual([
    'MAKHAZA',
    'MAKHAYA',
    'VILLAGE 3',
    'HARARE',
  ]);
});

test('schedule table does not mix weekend row sequences into a weekday view', () => {
  const { container } = render(
    <ScheduleTable
      selectedDirection="KHAYELITSHA - WYNBERG"
      selectedServiceDay="monday"
      scheduleData={{
        'KHAYELITSHA - WYNBERG': {
          name: 'KHAYELITSHA - WYNBERG',
          trips: [weekdayTrip, saturdayTrip],
          rows,
        },
      }}
      route={{ agency: 'GABS', code: '0068', name: 'WYNBERG - KHAYELITSHA' }}
    />
  );

  expect(
    Array.from(container.querySelectorAll('.stop-cell'), (cell) => cell.textContent)
  ).toEqual(['MAKHAZA', 'MAKHAYA', 'VILLAGE 3', 'HARARE']);
  expect(container.querySelector('.route-summary')).toHaveTextContent('lists 4 stops');
  expect(container.querySelector('tbody')).toHaveTextContent('04:50');
});

test('schedule table waits for a service-day selection instead of flashing mixed rows', () => {
  const { container } = render(
    <ScheduleTable
      selectedDirection="KHAYELITSHA - WYNBERG"
      selectedServiceDay=""
      scheduleData={{
        'KHAYELITSHA - WYNBERG': {
          name: 'KHAYELITSHA - WYNBERG',
          trips: [weekdayTrip, saturdayTrip],
          rows,
        },
      }}
      route={{ agency: 'GABS', code: '0068', name: 'WYNBERG - KHAYELITSHA' }}
    />
  );

  expect(container.querySelectorAll('.stop-cell')).toHaveLength(0);
  expect(container.querySelectorAll('thead th')).toHaveLength(1);
});

const mondayTrips = [
  { trip_id: 4, monday: true, friday: true, first_arrival: '17:00:00' },
  { trip_id: 2, monday: true, tuesday: true, wednesday: true, thursday: true, first_arrival: '13:00:00' },
  { trip_id: 1, monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, first_arrival: '13:00:00' },
  { trip_id: 3, friday: true, first_arrival: '12:45:00' },
];
const branchRows = [
  { name: 'PANORAMA', sequence: 0, stop_times: [1, 2].map(trip_id => ({ trip_id, arrival: '13:00:00', stop_time_type: 'scheduled' })) },
  { name: 'NYANGA', sequence: 1, stop_times: [{ trip_id: 1, stop_time_type: 'via' }, { trip_id: 2, stop_time_type: 'not_served' }] },
  { name: 'HARARE', sequence: 2, stop_times: [{ trip_id: 1, arrival: '15:15:00', stop_time_type: 'scheduled' }] },
  { name: 'MAKHAZA', sequence: 3, stop_times: [{ trip_id: 2, arrival: '15:00:00', stop_time_type: 'scheduled' }] },
];

test('Monday mixes operating patterns chronologically without merging simultaneous journeys', () => {
  const { getByText, getAllByRole, queryByRole } = render(<ScheduleTable selectedDirection="return" selectedServiceDay="monday"
    scheduleData={{ return: { name: 'Return', trips: mondayTrips, rows: branchRows } }} />);
  expect(getByText('Monday timetable')).toBeInTheDocument();
  const buttons = getAllByRole('button');
  expect(buttons.map(button => button.textContent)).toEqual([
    expect.stringContaining('13:00To HARARERuns Mon–Fri'),
    expect.stringContaining('13:00To MAKHAZARuns Mon–Thu'),
    expect.stringContaining('17:00'),
  ]);
  expect(queryByRole('button', { name: /12:45/ })).toBeNull();
});

test('trip details show only served stops, explain via, and restore keyboard focus', () => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  const { getByRole, getByText, queryByRole } = render(<ScheduleTable selectedDirection="return" selectedServiceDay="monday"
    scheduleData={{ return: { trips: mondayTrips, rows: branchRows } }} />);
  const opener = getByRole('button', { name: /13:00 to HARARE/ });
  opener.focus();
  fireEvent.click(opener);
  expect(getByRole('dialog')).toHaveTextContent('NYANGA');
  expect(getByRole('dialog')).not.toHaveTextContent('MAKHAZA');
  expect(getByText(/passes through; no time listed/)).toBeInTheDocument();
  fireEvent.click(getByRole('button', { name: 'Close' }));
  expect(queryByRole('dialog')).toBeNull();
  expect(opener).toHaveFocus();
});

test('Friday, weekend and holiday views use trip flags and describe their selected day', () => {
  const trips = [...mondayTrips, saturdayTrip, { trip_id: 7, public_holiday: true, first_arrival: '09:00:00' }];
  const scheduleData = { return: { trips, rows: branchRows } };
  const { rerender, getByRole, queryByRole } = render(<ScheduleTable selectedDirection="return"
    selectedServiceDay="friday" scheduleData={scheduleData} />);
  expect(getByRole('heading', { name: 'Friday timetable' })).toBeInTheDocument();
  expect(getByRole('button', { name: /12:45/ })).toBeInTheDocument();
  expect(queryByRole('button', { name: /runs Mon–Thu/ })).toBeNull();
  rerender(<ScheduleTable selectedDirection="return" selectedServiceDay="saturday" scheduleData={scheduleData} />);
  expect(getByRole('button', { name: /runs Sat/ })).toBeInTheDocument();
  rerender(<ScheduleTable selectedDirection="return" selectedServiceDay="public_holiday" scheduleData={scheduleData} />);
  expect(getByRole('heading', { name: 'Public holiday timetable' })).toBeInTheDocument();
  expect(getByRole('button', { name: /runs Public Holiday/ })).toBeInTheDocument();
});

test('partial and overnight journeys sort by first timed stop, retaining different intermediate stops', () => {
  const trips = [1, 2].map(trip_id => ({ trip_id, monday: true, first_arrival: '00:10:00' }));
  const journeyRows = [
    { name: 'Origin', sequence: 0, stop_times: trips.map(t => ({ trip_id: t.trip_id, stop_time_type: 'not_served' })) },
    { name: 'Board here', sequence: 1, stop_times: trips.map(t => ({ trip_id: t.trip_id, arrival: '23:50:00' })) },
    { name: 'Branch', sequence: 2, stop_times: [{ trip_id: 2, stop_time_type: 'via' }] },
    { name: 'Destination', sequence: 3, stop_times: trips.map(t => ({ trip_id: t.trip_id, arrival: '00:10:00' })) },
  ];
  const visible = getVisibleTrips(trips, 'monday', journeyRows);
  expect(visible.map(t => t.details.firstTime)).toEqual(['23:50:00', '23:50:00']);
  expect(getTripDetails(trips[0], journeyRows).stops.map(s => s.name)).toEqual(['Board here', 'Destination']);
  expect(getTripDetails(trips[1], journeyRows).stops.map(s => s.name)).toEqual(['Board here', 'Branch', 'Destination']);
});
