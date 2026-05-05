import React from 'react';
import RouteLinkList from './RouteLinkList';
import SeoAdLayout from './SeoAdLayout';
import SiteFooter from './SiteFooter';
import {
  getRouteAreaNames,
  getRouteLabel,
  slugify,
  titleizeSlug,
} from './routeUtils';

export function AreaPage({ areaSlug, schedules, loadingSchedules }) {
  const areaName = titleizeSlug(areaSlug);
  const routes = schedules
    .filter((schedule) =>
      getRouteAreaNames(schedule).some((name) => slugify(name) === areaSlug)
    )
    .sort((first, second) => getRouteLabel(first).localeCompare(getRouteLabel(second)));

  return (
    <main className="info-page">
      <SeoAdLayout>
        <section className="info-panel seo-content-panel">
          <p className="info-eyebrow">Cape Town bus area</p>
          <h1>{areaName} bus timetables</h1>
          <p>
            Find Golden Arrow and MyCiTi routes serving {areaName}. Select a route to view its
            timetable, stops, directions, and service days.
          </p>
          <h2>Routes serving {areaName}</h2>
          {loadingSchedules ? (
            <p>Loading routes...</p>
          ) : (
            <RouteLinkList
              routes={routes}
              emptyMessage="No route matches are loaded for this area yet. Use search to find a route."
            />
          )}
        </section>
      </SeoAdLayout>
      <SiteFooter />
    </main>
  );
}

export function AreasIndexPage({ schedules, loadingSchedules }) {
  const areas = [...new Set(schedules.flatMap(getRouteAreaNames))]
    .sort((first, second) => first.localeCompare(second));

  return (
    <main className="info-page">
      <SeoAdLayout>
        <section className="info-panel seo-content-panel">
          <p className="info-eyebrow">Cape Town bus areas</p>
          <h1>Cape Town bus areas and stops</h1>
          <p>
            Browse Golden Arrow and MyCiTi timetable pages by Cape Town area, stop, and route coverage.
          </p>
          <h2>Areas and stops</h2>
          {loadingSchedules ? (
            <p>Loading areas...</p>
          ) : (
            <div className="seo-area-links">
              {areas.map((areaName) => (
                <a key={areaName} href={`/areas/${slugify(areaName)}`}>
                  {titleizeSlug(slugify(areaName))}
                </a>
              ))}
            </div>
          )}
        </section>
      </SeoAdLayout>
      <SiteFooter />
    </main>
  );
}
