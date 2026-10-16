import React, { useEffect, useId, useRef, useState } from 'react';
import { trackEvent } from './analytics';
import { filterRoutes, getAgencyDisplayName } from './routeUtils';
import { RouteTileContent } from './RouteLinkList';
import './RouteDiscovery.css';

const SchedulesDropdown = ({
  className = '',
  placeholder = 'Search route...',
  onRouteSelect,
  onAgencyChange,
  schedules = [],
  selectedAgency = '',
  searchLocation = 'timetable_search',
  query: controlledQuery,
  onQueryChange,
  showResults = true,
}) => {
  const [localQuery, setLocalQuery] = useState('');
  const [showOptions, setShowOptions] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const lastTrackedSearch = useRef('');
  const resultsRef = useRef(null);
  const resultsId = useId();
  const query = controlledQuery === undefined ? localQuery : controlledQuery;
  const resultsOpen = showResults && showOptions;

  const agencies = [...new Set(schedules.map((schedule) => schedule.agency))].filter(Boolean);
  const filtered = filterRoutes(schedules, query, selectedAgency);

  const setQuery = (value) => {
    if (controlledQuery === undefined) setLocalQuery(value);
    onQueryChange?.(value);
  };

  const handleAgencyChange = (event) => {
    const agency = event.target.value;

    onAgencyChange?.(agency);

    setActiveIndex(-1);
  };

  const handleRouteSelect = (selectedOption) => {
    onRouteSelect?.(selectedOption, { source: searchLocation });
    setQuery('');
    setShowOptions(false);
    setActiveIndex(-1);
  };

  const handleKeyDown = (event) => {
    if (event.key === 'Escape') {
      setShowOptions(false);
      setActiveIndex(-1);
    } else if (showResults && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      setShowOptions(true);
      if (!filtered.length) return;
      setActiveIndex((index) => event.key === 'ArrowDown'
        ? (index + 1) % filtered.length
        : (index <= 0 ? filtered.length - 1 : index - 1));
    } else if (event.key === 'Enter' && filtered.length && (!showResults || resultsOpen)) {
      event.preventDefault();
      handleRouteSelect(filtered[activeIndex] || filtered[0]);
    }
  };

  useEffect(() => {
    setActiveIndex(-1);
  }, [query, selectedAgency]);

  useEffect(() => {
    if (resultsOpen && activeIndex >= 0) {
      resultsRef.current?.children[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [activeIndex, resultsOpen]);

  useEffect(() => {
    const normalizedQuery = query.trim().toLowerCase();

    if (normalizedQuery.length < 2) {
      lastTrackedSearch.current = '';
      return undefined;
    }

    const searchKey = `${selectedAgency}|${normalizedQuery}|${filtered.length}`;
    const timer = window.setTimeout(() => {
      if (lastTrackedSearch.current === searchKey) {
        return;
      }

      lastTrackedSearch.current = searchKey;
      const queryLengthBucket = normalizedQuery.length <= 3
        ? '2-3'
        : normalizedQuery.length <= 7 ? '4-7' : '8+';
      const parameters = {
        agency: selectedAgency || 'all',
        search_location: searchLocation,
        result_count: filtered.length,
        query_length_bucket: queryLengthBucket,
      };

      trackEvent('route_search', parameters);
      if (filtered.length === 0) {
        trackEvent('no_search_results', parameters);
      }
    }, 750);

    return () => window.clearTimeout(timer);
  }, [filtered.length, query, searchLocation, selectedAgency]);

  return (
    <div className={`schedule-picker route-search-picker ${className}`.trim()}>
      <select
        className="agency-select"
        aria-label="Operator"
        value={selectedAgency || ''}
        onChange={handleAgencyChange}
      >
        <option value="">All operators</option>
        {agencies.map((agency) => (
          <option key={agency} value={agency}>
            {getAgencyDisplayName(agency)}
          </option>
        ))}
      </select>
      <div className="dropdown">
        <input
          type="text"
          role={showResults ? 'combobox' : 'searchbox'}
          aria-label="Search routes"
          aria-autocomplete={showResults ? 'list' : undefined}
          aria-expanded={showResults ? resultsOpen : undefined}
          aria-controls={resultsOpen ? resultsId : undefined}
          aria-activedescendant={resultsOpen && filtered[activeIndex] ? `${resultsId}-${activeIndex}` : undefined}
          autoComplete="off"
          value={query}
          placeholder={placeholder}
          onChange={(event) => {
            setQuery(event.target.value);
            setShowOptions(true);
          }}
          onFocus={() => setShowOptions(true)}
          onBlur={() => setShowOptions(false)}
          onKeyDown={handleKeyDown}
        />
        {resultsOpen && (
          <div className="dropdown-menu route-search-results">
            <ul id={resultsId} role="listbox" aria-label="Matching routes" ref={resultsRef}>
              {filtered.map((schedule, index) => (
                <li
                  key={schedule.id || `${schedule.agency}:${schedule.code}:${schedule.name}`}
                  id={`${resultsId}-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  className="route-search-option"
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => handleRouteSelect(schedule)}
                >
                  <RouteTileContent route={schedule} />
                </li>
              ))}
            </ul>
            {filtered.length === 0 && <p className="route-search-empty" role="status">No routes found. Try another place, route number or operator.</p>}
          </div>
        )}
      </div>
    </div>
  );
};

export default SchedulesDropdown;
