import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import SavedTimetablesPage from './SavedTimetablesPage';
import { getSavedTimetables, setTimetableSaved } from './timetableCache';

jest.mock('./timetableCache', () => ({
  getSavedTimetables: jest.fn(),
  isTimetableStorageAvailable: () => true,
  setTimetableSaved: jest.fn(),
}));

jest.mock('./analytics', () => ({
  getOnlineState: () => 'online',
  trackEvent: jest.fn(),
}));

const savedRecord = {
  routeId: 300,
  saved: true,
  savedAt: Date.UTC(2026, 7, 1),
  lastViewedAt: Date.UTC(2026, 7, 2),
  routeSnapshot: {
    id: 300,
    agency: 'GABS',
    code: '0004',
    name: 'ATLANTIS - CAPE TOWN',
  },
};

beforeEach(() => {
  jest.clearAllMocks();
});

test('renders the saved empty state', async () => {
  getSavedTimetables.mockResolvedValue([]);
  render(<SavedTimetablesPage schedules={[]} onViewRoute={() => {}} />);

  expect(await screen.findByRole('heading', { name: 'No saved timetables yet' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Find a timetable' })).toHaveAttribute('href', '/');
});

test('lists, opens, and removes a saved timetable only after IndexedDB succeeds', async () => {
  getSavedTimetables.mockResolvedValue([savedRecord]);
  setTimetableSaved.mockResolvedValue(true);
  const onViewRoute = jest.fn();
  render(<SavedTimetablesPage schedules={[]} onViewRoute={onViewRoute} />);

  const routeHeading = await screen.findByRole('heading', { name: 'Atlantis → Cape Town' });
  expect(routeHeading).toBeInTheDocument();
  fireEvent.click(screen.getByRole('link', { name: 'View timetable' }));
  expect(onViewRoute).toHaveBeenCalledWith(savedRecord.routeSnapshot);

  fireEvent.click(screen.getByRole('button', { name: 'Remove from saved' }));
  await waitFor(() => expect(setTimetableSaved).toHaveBeenCalledWith(savedRecord.routeSnapshot, false));
  expect(await screen.findByRole('heading', { name: 'No saved timetables yet' })).toBeInTheDocument();
});

test('matches current notice data by operator and code even after route IDs change', async () => {
  getSavedTimetables.mockResolvedValue([{
    ...savedRecord,
    routeSnapshot: { ...savedRecord.routeSnapshot, timetableStatus: { label: 'Old notice', kind: 'pending' } },
  }]);
  render(<SavedTimetablesPage schedules={[{
    ...savedRecord.routeSnapshot,
    id: 999,
    timetableStatus: { label: 'Timetable needs updating', kind: 'expired', cached: true },
  }]} onViewRoute={() => {}} />);
  expect(await screen.findByText('Timetable needs updating · last known')).toBeInTheDocument();
  expect(screen.queryByText('Old notice')).not.toBeInTheDocument();
});

test('clears an old saved notice when the current catalogue has no notice', async () => {
  getSavedTimetables.mockResolvedValue([{
    ...savedRecord,
    routeSnapshot: { ...savedRecord.routeSnapshot, timetableStatus: { label: 'Old notice', kind: 'pending' } },
  }]);
  render(<SavedTimetablesPage schedules={[savedRecord.routeSnapshot]} onViewRoute={() => {}} />);
  expect(await screen.findByRole('heading', { name: 'Atlantis → Cape Town' })).toBeInTheDocument();
  expect(screen.queryByText('Old notice')).not.toBeInTheDocument();
});

test('keeps unresolved legacy records removable without offering a broken route link', async () => {
  getSavedTimetables.mockResolvedValue([{ ...savedRecord, routeSnapshot: null }]);
  setTimetableSaved.mockResolvedValue(false);
  render(<SavedTimetablesPage schedules={[]} onViewRoute={() => {}} />);

  expect(await screen.findByRole('heading', { name: 'Route details unavailable offline' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'View timetable' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Remove from saved' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('could not update');
});
