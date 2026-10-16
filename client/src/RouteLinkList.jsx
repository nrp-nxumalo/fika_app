import React from 'react';
import {
  getAgencyDisplayName,
  getRoutePresentation,
  getTimetablePath,
} from './routeUtils';
import { trackEvent } from './analytics';
import './RouteDiscovery.css';

export function RouteTileContent({ route, titleAs: Title = 'span' }) {
  const presentation = getRoutePresentation(route);
  const status = route.timetableStatus;

  return (
    <>
      <span className="route-tile-meta">
        <span>{getAgencyDisplayName(route.agency)}</span>
        {route.code && <span className="route-tile-code">{route.code}</span>}
      </span>
      <Title className="route-tile-title">{presentation.label}</Title>
      {presentation.via && <span className="route-tile-via">via {presentation.via}</span>}
      {status?.label && (
        <span className={`route-status-badge route-status-badge--${status.kind || 'pending'}`}>
          {status.label}{status.cached ? ' · last known' : ''}
        </span>
      )}
    </>
  );
}

export default function RouteLinkList({ routes = [], emptyMessage, selectionSource, onRouteSelect }) {
  if (!routes.length) {
    return <p>{emptyMessage}</p>;
  }

  return (
    <div className="seo-route-grid route-discovery-grid">
      {routes.map((schedule) => (
        <a
          key={schedule.id || `${schedule.agency}:${schedule.code}:${schedule.name}`}
          className="route-tile"
          href={getTimetablePath(schedule)}
          onClick={(event) => {
            if (onRouteSelect && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
              event.preventDefault();
              onRouteSelect(schedule, { source: selectionSource || 'route_list' });
              return;
            }
            if (selectionSource) {
              trackEvent('route_selected', {
                agency: schedule.agency,
                route_code: schedule.code || 'unknown',
                selection_source: selectionSource,
              });
            }
          }}
        >
          <RouteTileContent route={schedule} />
        </a>
      ))}
    </div>
  );
}
