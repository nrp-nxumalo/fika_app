import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { capeTownDay } from './TimetableStatus';
import { getTimetablePath } from './routeUtils';
import { getCachedTimetable, getCachedTimetableStatus, getCachedSchedules, findSavedTimetableByLocator } from './timetableCache';

jest.mock('./analytics', () => ({
  getOnlineState: () => navigator.onLine === false ? 'offline' : 'online',
  trackEvent: jest.fn(), trackPageView: jest.fn(), trackTimetableView: jest.fn(),
}));
jest.mock('./timetableCache', () => ({
  getCachedSchedules: jest.fn().mockResolvedValue(null),
  getCachedTimetable: jest.fn().mockResolvedValue(null),
  getCachedTimetableStatus: jest.fn().mockResolvedValue(null),
  findSavedTimetableByLocator: jest.fn().mockResolvedValue(null),
  saveSchedulesToCache: jest.fn().mockResolvedValue(),
  saveTimetableStatusToCache: jest.fn().mockResolvedValue(),
  saveTimetableToCache: jest.fn().mockResolvedValue(true),
  setTimetableSaved: jest.fn().mockResolvedValue(true), touchTimetable: jest.fn().mockResolvedValue(),
}));

const route = { id: 98, code: '0098', name: 'Bluedowns - Cape Town', agency: 'GABS', direction_1: 'Bluedowns - Mowbray - Cape Town', direction_2: 'Cape Town - Mowbray - Bluedowns' };
const otherRoute = { id: 242, code: '242', name: 'Atlantis - Mamre', agency: 'MyCiti', direction_1: 'Atlantis - Mamre', direction_2: 'Mamre - Atlantis' };
const payload = (item) => ({ version: 2, route_id: item.id, directions: [item.direction_1, item.direction_2].map((name, index) => ({
  id: index + 1, name,
  trips: [{ trip_id: index + 1, monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: true, sunday: true }],
  rows: [
    { name: 'Origin', sequence: 0, stop_times: [{ trip_id: index + 1, arrival: '07:00:00', stop_time_type: 'scheduled' }] },
    { name: 'Middle', sequence: 1, stop_times: [{ trip_id: index + 1, arrival: '07:20:00', stop_time_type: 'scheduled' }] },
    { name: 'Destination', sequence: 2, stop_times: [{ trip_id: index + 1, arrival: '08:00:00', stop_time_type: 'scheduled' }] },
  ],
})) });
let schedules;
beforeEach(() => {
  schedules = [route, otherRoute];
  window.history.replaceState({}, '', '/');
  window.scrollTo = jest.fn();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  getCachedTimetableStatus.mockResolvedValue(null);
  getCachedSchedules.mockResolvedValue(null);
  getCachedTimetable.mockResolvedValue(null);
  findSavedTimetableByLocator.mockResolvedValue(null);
  global.fetch = jest.fn(async (url) => {
    const pathname = new URL(url, 'http://localhost').pathname;
    const data = pathname === '/schedules' ? schedules
      : pathname === '/api/timetable-status' ? { checked_at: '2026-10-14T03:00:00Z', routes: [] }
      : payload(pathname.endsWith('/242') ? otherRoute : route);
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => data };
  });
});

test('home defaults to all operators, shares search with tiles and reveals routes in batches', async () => {
  schedules = Array.from({ length: 30 }, (_, index) => ({ ...route, id: index + 1, code: String(index + 1), name: `Area ${index + 1} - Cape Town` }));
  const { container } = render(<App />);
  await waitFor(() => expect(container.querySelectorAll('.route-tile')).toHaveLength(24));
  expect(screen.getByLabelText('Operator')).toHaveValue('');
  expect(container.querySelector('.area-link-band').compareDocumentPosition(container.querySelector('.home-routes')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(container.querySelector('.coverage-band')).not.toBeInTheDocument();
  expect(container.querySelector('.landing-copy')).toHaveTextContent('30 route timetables for Cape Town bus commuters.');
  fireEvent.click(screen.getByRole('button', { name: 'Show more routes' }));
  expect(container.querySelectorAll('.route-tile')).toHaveLength(30);
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search routes' }), { target: { value: 'Area 30' } });
  expect(container.querySelectorAll('.route-tile')).toHaveLength(1);
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});

test('commuters can filter boarding, switch direction and search another operator without losing their route', async () => {
  window.history.replaceState({}, '', getTimetablePath(route));
  render(<App />);
  await screen.findByLabelText('Boarding at');
  expect(screen.getByLabelText('Service day')).toHaveValue(capeTownDay());
  fireEvent.change(screen.getByLabelText('Boarding at'), { target: { value: 'middle' } });
  expect(screen.getByRole('button', { name: /Show stops/ })).toHaveTextContent('07:20');
  fireEvent.click(screen.getByRole('button', { name: /Show stops/ }));
  expect(screen.getByRole('list', { name: 'Trip stops and times' })).toHaveTextContent('Selected stop');
  fireEvent.change(screen.getByLabelText('Service day'), { target: { value: 'friday' } });
  fireEvent.click(screen.getByRole('button', { name: 'Bluedowns', exact: true }));
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('→ Bluedowns');
  expect(screen.getByLabelText('Service day')).toHaveValue('friday');
  expect(screen.getByLabelText('Boarding at')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('Operator'), { target: { value: 'MyCiti' } });
  expect(window.location.pathname).toBe(getTimetablePath(route));
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('→ Bluedowns');
  const search = screen.getByRole('combobox', { name: 'Search routes' });
  fireEvent.change(search, { target: { value: 'Mamre' } });
  fireEvent.keyDown(search, { key: 'ArrowDown' });
  fireEvent.keyDown(search, { key: 'Enter' });
  await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('→ Mamre'));
  expect(window.location.pathname).toBe(getTimetablePath(otherRoute));
  fireEvent.change(screen.getByLabelText('Service day'), { target: { value: 'public_holiday' } });
  expect(screen.getByText('No trips listed for Public holiday')).toBeInTheDocument();
});

test('saved routes cold-start offline even when the catalogue and status endpoint fail', async () => {
  window.history.replaceState({}, '', getTimetablePath(route));
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
  global.fetch.mockRejectedValue(new Error('Offline'));
  findSavedTimetableByLocator.mockResolvedValue({ routeSnapshot: route });
  getCachedTimetable.mockResolvedValue({ routeSnapshot: route, data: payload(route), saved: true });
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  render(<App />);
  await screen.findByLabelText('Boarding at');
  expect(screen.getByLabelText('Save offline')).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: /Show stops/ }));
  expect(screen.getByRole('list', { name: 'Trip stops and times' })).toHaveTextContent('Middle');
  const freshPayload = payload(route);
  freshPayload.directions[0].rows[0].stop_times[0].arrival = '07:10:00';
  global.fetch.mockImplementation(async (url) => ({ ok: true,
    headers: { get: () => 'application/json' },
    json: async () => String(url).includes('timetable-status') ? { checked_at: '2026-10-15T03:00:00Z', routes: [] } : freshPayload,
  }));
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  act(() => window.dispatchEvent(new Event('online')));
  await waitFor(() => expect(screen.getByRole('button', { name: /(?:Show|Hide) stops/ })).toHaveTextContent('07:10'));
  expect(screen.queryByText(/Showing saved timetable times/)).not.toBeInTheDocument();
  log.mockRestore();
});

test('uses loaded direction names when they differ from the catalogue and exposes extra branches', async () => {
  window.history.replaceState({}, '', getTimetablePath(route));
  const freshPayload = payload(route);
  freshPayload.directions[0].name = 'New outbound direction';
  freshPayload.directions.push({ ...freshPayload.directions[0], id: 3, name: 'School branch' });
  const originalFetch = global.fetch.getMockImplementation();
  global.fetch.mockImplementation(async (url) => String(url).includes('schedule_times')
    ? { ok: true, headers: { get: () => 'application/json' }, json: async () => freshPayload }
    : originalFetch(url));
  render(<App />);
  await screen.findByLabelText('Boarding at');
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('New Outbound Direction');
  fireEvent.click(screen.getByRole('button', { name: 'School Branch' }));
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('School Branch');
  expect(screen.getByRole('button', { name: /Show stops/ })).toBeInTheDocument();
});

test('distinguishes GABS directions with the same destination by their full timetable numbers', async () => {
  const atlantisRoute = { ...route, id: 105, code: '0105', name: 'Atlantis - Bellville',
    direction_1: 'Atlantis - Bellville', direction_2: 'Bellville - Atlantis' };
  schedules = [atlantisRoute];
  window.history.replaceState({}, '', getTimetablePath(atlantisRoute));
  const freshPayload = payload(atlantisRoute);
  freshPayload.directions = ['01', '02', '03', '04'].map((code, index) => ({
    ...freshPayload.directions[index % 2], id: index + 1, code,
    name: ['Atlantis - Bellville', 'Bellville - Atlantis',
      'Atlantis - Table View - Bellville', 'Bellville - Table View - Atlantis'][index],
  }));
  freshPayload.directions[2].rows = freshPayload.directions[2].rows.map(row => ({
    ...row, stop_times: row.stop_times.map(cell => ({ ...cell, arrival: '09:00:00' })),
  }));
  const originalFetch = global.fetch.getMockImplementation();
  global.fetch.mockImplementation(async (url) => String(url).includes('schedule_times')
    ? { ok: true, headers: { get: () => 'application/json' }, json: async () => freshPayload }
    : originalFetch(url));
  render(<App />);
  const firstBellville = await screen.findByRole('button', { name: 'Bellville 010501' });
  const secondBellville = screen.getByRole('button', { name: 'Bellville 010503' });
  expect(firstBellville).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Atlantis 010502' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Atlantis 010504' })).toBeInTheDocument();
  fireEvent.click(secondBellville);
  expect(secondBellville).toHaveAttribute('aria-pressed', 'true');
  expect(firstBellville).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('button', { name: /Show stops/ })).toHaveTextContent('09:00');
});
