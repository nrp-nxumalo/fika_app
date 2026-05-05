import React from 'react';
import RouteLinkList from './RouteLinkList';
import SeoAdLayout from './SeoAdLayout';
import SiteFooter from './SiteFooter';
import {
  getAgencyDisplayName,
  getRouteAreaNames,
  getRouteLabel,
  slugify,
  titleizeSlug,
} from './routeUtils';

const OPERATOR_SERVICE_URLS = {
  GABS: 'https://www.gabs.co.za/',
  MyCiti: 'https://www.myciti.org.za',
};

export default function OperatorPage({ agency, schedules, loadingSchedules }) {
  const agencyName = getAgencyDisplayName(agency);
  const operatorServiceUrl = OPERATOR_SERVICE_URLS[agency];
  const routes = schedules
    .filter((schedule) => schedule.agency === agency)
    .sort((first, second) => getRouteLabel(first).localeCompare(getRouteLabel(second)));
  const areas = [...new Set(routes.flatMap(getRouteAreaNames))]
    .sort((first, second) => first.localeCompare(second))
    .slice(0, 36);

  return (
    <main className="info-page">
      <SeoAdLayout>
        <section className="info-panel seo-content-panel">
          <p className="info-eyebrow">Cape Town bus operator</p>
          <h1>{agencyName} bus timetables</h1>
          <p>
            Search {agencyName} route timetables for Cape Town by route number, route name, area,
            and direction.
          </p>
          {operatorServiceUrl && (
            <p className="operator-official-link">
              For fares, cards, notices, accessibility, and other operator-specific service details,
              visit the official{' '}
              <a href={operatorServiceUrl} target="_blank" rel="noopener noreferrer">
                {agencyName} website
              </a>.
            </p>
          )}
          <h2>{agencyName} routes</h2>
          {loadingSchedules ? (
            <p>Loading routes...</p>
          ) : (
            <RouteLinkList routes={routes} emptyMessage="No routes are available for this operator yet." />
          )}
          {areas.length > 0 && (
            <>
              <h2>{agencyName} areas</h2>
              <div className="seo-area-links">
                {areas.map((areaName) => (
                  <a key={areaName} href={`/areas/${slugify(areaName)}`}>
                    {titleizeSlug(slugify(areaName))}
                  </a>
                ))}
              </div>
            </>
          )}
        </section>
      </SeoAdLayout>
      <SiteFooter />
    </main>
  );
}
