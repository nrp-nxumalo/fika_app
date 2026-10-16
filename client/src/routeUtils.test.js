import { filterRoutes, getAvailableRouteCount, getDirectionDestination, getRouteCountLabel, getRoutePresentation, getRouteSeoTitle, getTimetablePath } from './routeUtils';

test('builds the homepage route count dynamically from unique available routes', () => {
  const routes = [
    { id: 1, agency: 'GABS', code: '0001', name: 'First route' },
    { id: 2, agency: 'MyCiti', code: '214A', name: 'Second route' },
    { id: 2, agency: 'MyCiti', code: '214A', name: 'Second route' },
  ];

  expect(getAvailableRouteCount(routes)).toBe(2);
  expect(getRouteCountLabel(getAvailableRouteCount(routes))).toBe('2 route timetables');
});

test('presents endpoints and intermediate places without changing canonical names or SEO', () => {
  const route = { agency: 'GABS', code: '0098', name: 'BLUEDOWNS - MOWBRAY - CAPE TOWN' };
  expect(getRoutePresentation(route)).toEqual({
    origin: 'Bluedowns', destination: 'Cape Town', via: 'Mowbray', label: 'Bluedowns → Cape Town',
  });
  expect(route.name).toBe('BLUEDOWNS - MOWBRAY - CAPE TOWN');
  expect(getTimetablePath(route)).toBe('/timetables/golden-arrow/route-0098-bluedowns-mowbray-cape-town');
  expect(getRouteSeoTitle(route)).toBe('Golden Arrow 0098 Bluedowns–Cape Town Bus Times');
});

test('derives shared via places from directions in journey order', () => {
  const route = {
    name: 'A - D',
    direction_1: 'D - C - B - A',
    direction_2: 'A - B - C - D',
  };
  expect(getRoutePresentation(route)).toMatchObject({ label: 'A → D', via: 'B · C' });
  expect(getRoutePresentation(route, route.direction_1)).toMatchObject({ label: 'D → A', via: 'C · B' });
});

test('does not claim a shared via when directions follow different paths', () => {
  const route = {
    name: 'Bluedowns - Mowbray - Cape Town',
    direction_1: 'Bluedowns - Mowbray - Cape Town',
    direction_2: 'Cape Town - Bellville - Bluedowns',
  };
  expect(getRoutePresentation(route).via).toBe('');
  expect(getRoutePresentation(route, route.direction_2)).toMatchObject({ label: 'Cape Town → Bluedowns', via: 'Bellville' });
  expect(getRoutePresentation({ ...route, direction_2: 'Cape Town - Bluedowns' }).via).toBe('');
});

test('preserves loop and branch qualifiers and understands explicit via and destination directions', () => {
  const route = { name: 'Mamre (Crown) - Atlantis (Clockwise)' };
  expect(getRoutePresentation(route).label).toBe('Mamre (Crown) → Atlantis (Clockwise)');
  expect(getRoutePresentation({ name: 'A - D' }, 'D to A via C - B')).toMatchObject({ label: 'D → A', via: 'C · B' });
  expect(getRoutePresentation({ name: 'A - B - C - D' }, 'To A')).toMatchObject({ label: 'D → A', via: 'C · B' });
  expect(getRoutePresentation(null)).toEqual({ origin: '', destination: '', via: '', label: '' });
  expect(getRoutePresentation({ name: 'Parklands - Table View' }, 'To Marine Circle'))
    .toMatchObject({ label: 'To Marine Circle', destination: 'Marine Circle', origin: '', via: '' });
});

test('searches original names, directions, route codes and friendly operator names with a shared agency filter', () => {
  const routes = [
    { id: 1, agency: 'GABS', code: '0098', name: 'Bluedowns - Cape Town', direction_1: 'Bluedowns - Mowbray - Cape Town' },
    { id: 2, agency: 'MyCiti', code: '214A', name: 'Atlantis - Cape Town' },
  ];
  expect(filterRoutes(routes, 'Mowbray')).toEqual([routes[0]]);
  expect(filterRoutes(routes, 'golden 0098')).toEqual([routes[0]]);
  expect(filterRoutes(routes, ' cape town ', 'MyCiti')).toEqual([routes[1]]);
  expect(filterRoutes(routes, '', '')).toEqual(routes);
  expect(filterRoutes(routes, 'Mowbray', 'MyCiti')).toEqual([]);
});

test('uses the destination consistently for MyCiTi labels with or without a To prefix', () => {
  const route = { agency: 'MyCiti', code: '107', name: 'Civic Centre - Camps Bay (Anticlockwise)' };
  expect(getDirectionDestination(route, 'Camps Bay')).toBe('Camps Bay');
  expect(getDirectionDestination(route, 'To Civic Centre')).toBe('Civic Centre');
  expect(getDirectionDestination(route, '  TO CIVIC CENTRE  ')).toBe('Civic Centre');
  expect(getDirectionDestination(route, { name: 'Civic Centre' })).toBe('Civic Centre');
  expect(getDirectionDestination(route, 'To Sea Point')).toBe('Sea Point');
});

test('uses the final endpoint for Golden Arrow directions without including via places', () => {
  const route = { agency: 'GABS', code: '0098', name: 'BLUEDOWNS - MOWBRAY - CAPE TOWN' };
  expect(getDirectionDestination(route, 'BLUEDOWNS - MOWBRAY - CAPE TOWN')).toBe('Cape Town');
  expect(getDirectionDestination(route, 'CAPE TOWN - MOWBRAY - BLUEDOWNS')).toBe('Bluedowns');
  expect(getDirectionDestination(route, 'Bluedowns to Cape Town via Mowbray')).toBe('Cape Town');
  expect(getDirectionDestination(route, 'To Bluedowns via Mowbray')).toBe('Bluedowns');
});

test('retains destination qualifiers without carrying over qualifiers from the origin', () => {
  const route = { name: 'Civic Centre - Camps Bay (Anticlockwise)' };
  expect(getDirectionDestination(route, 'Civic Centre - Camps Bay (Anticlockwise)')).toBe('Camps Bay (Anticlockwise)');
  expect(getDirectionDestination(route, 'Camps Bay (Anticlockwise) - Civic Centre')).toBe('Civic Centre');
  expect(getDirectionDestination({ name: 'Atlantis - Mamre (Crown)' }, { direction: 'ATLANTIS - MAMRE (CROWN)' })).toBe('Mamre (Crown)');
  expect(getDirectionDestination(route)).toBe('Camps Bay (Anticlockwise)');
  expect(getDirectionDestination(null)).toBe('');
  expect(getRoutePresentation(route).label).toBe('Civic Centre → Camps Bay (Anticlockwise)');
});
