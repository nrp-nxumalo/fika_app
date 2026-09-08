"""Independent GABS sections, with document provenance outside canonical hashes."""
from __future__ import annotations

import copy
import io
import json
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

import pdfplumber

from .canonical import SERVICE_DAYS, content_sha256, sha256_bytes, validate_extraction
from .adapters.base import ParseError


def review_summary(extraction):
    """Small family fingerprints for review lists, separate from content identity."""
    if not extraction:
        return {}
    direction = extraction['routes'][0]['directions'][0]
    families = {'weekday': SERVICE_DAYS[:5], 'saturday': ('saturday',),
                'sunday': ('sunday',), 'public_holiday': ('public_holiday',)}
    summary = {'effective_date': extraction['effective_date'],
               'direction_name': direction['name'], 'families': {}}
    for family, days in families.items():
        trips = [{'times': trip['times'], 'serviceDays': [d for d in days if d in trip['service_days']]}
                 for service in direction['services'] for trip in service['trips']
                 if set(days).intersection(trip['service_days'])]
        if trips:
            signature = json.dumps({'name': direction['name'], 'trips': trips},
                                   ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
            summary['families'][family] = {'content_sha256': sha256_bytes(signature), 'trip_count': len(trips)}
    return summary


def split_extraction(extraction):
    """Project a legacy approved bundle without changing any trip or stop vector."""
    for route in extraction['routes']:
        for direction in route['directions']:
            number = route['code'] + direction['code']
            names = [p.strip() for p in direction['name'].split(' - ') if p.strip()]
            name = f'{names[0]} - {names[-1]}' if len(names) > 1 else direction['name']
            result = {
                'schema_version': 1, 'operator': 'GABS', 'source_key': number,
                'publication_scope': 'service_days', 'effective_date': direction['effective_date'],
                'routes': [{'code': route['code'], 'name': name, 'directions': [copy.deepcopy(direction)]}],
            }
            validate_extraction(result)
            yield number, result


def scan_pages(pages):
    """Find section boundaries before interpreting tables, preserving physical pages."""
    from .adapters.gabs import _is_probable_title
    sections, current, seen_pages = [], None, {}
    title_since_header = False
    for page_number, text in enumerate(pages, 1):
        lines = text.splitlines()
        page_key = '\n'.join(line.strip() for line in lines)
        numbered = bool(re.search(r'TIMETABLE NUMBER:\s*\d{4}\s*\d{2}\b', text))
        if numbered and page_key in seen_pages:
            for section in seen_pages[page_key]:
                section['pages'].append(page_number)
            continue
        # Footer-only continuation pages belong to the preceding timetable.
        for line in lines:
            upper = line.strip().upper()
            title = _is_probable_title(line) and not re.match(r'^[A-Za-z*#†‡]\s*-\s*', line.strip())
            identity = re.search(r'TIMETABLE NUMBER:\s*(\d{4})\s*(\d{2})\b', line)
            number = identity.group(1) + identity.group(2) if identity else None
            if title:
                title_since_header = True
            if title and (current is None or upper != current['title']):
                current = {'title': upper, 'timetable_number': None, 'lines': [], 'pages': []}
                sections.append(current)
            if number and current and current['timetable_number']:
                # A fresh header starts another printed section; a numbered
                # continuation page retains the same section and stop blocks.
                continuation = bool(re.search(r'PAGE:\s*([2-9]|[1-9][0-9]+)\b', text))
                if number != current['timetable_number'] or not continuation:
                    inherited_title = current['title'] if title_since_header or number[:4] == current['timetable_number'][:4] else ''
                    current = {'title': inherited_title, 'timetable_number': number,
                               'lines': [inherited_title], 'pages': []}
                    sections.append(current)
            if number and current is None:
                current = {'title': '', 'timetable_number': number, 'lines': [], 'pages': []}
                sections.append(current)
            if current:
                current['lines'].append(line)
                if page_number not in current['pages']:
                    current['pages'].append(page_number)
                if number:
                    current['timetable_number'] = number
                    title_since_header = False
        if numbered:
            seen_pages[page_key] = [section for section in sections if page_number in section['pages']]
    return [s for s in sections if s['timetable_number'] or any(l.startswith('|') for l in s['lines'])]


def parse_gabs_document(source, pdf_bytes):
    from .adapters.gabs import (_canonical_service, _effective_date_from_source_name,
                               _parse_timetable_lines, _resolve_headerless_timetables)
    source_name = Path(unquote(urlsplit(source.url).path)).name
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            scanned = scan_pages([page.extract_text() or '' for page in pdf.pages])
    except Exception as exc:
        raise ParseError(f'could not read GABS PDF {source_name}: {exc}') from exc
    results, issues, parsed = [], [], []
    for section in scanned:
        try:
            values = _parse_timetable_lines(section['lines'], source_name, allow_headerless=True)
            if len(values) != 1:
                raise ParseError('malformed header or ambiguous section boundary; expected exactly one timetable')
            if section['timetable_number'] and not values[0].get('timetable_number'):
                raise ParseError(f"malformed header for timetable {section['timetable_number']}")
            parsed.append((section, values[0]))
        except (ValueError, KeyError) as exc:
            result = {'timetable_number': section['timetable_number'], 'pages': section['pages'], 'error': str(exc)}
            (results if result['timetable_number'] else issues).append(result)
    headerless = [pair for pair in parsed if not pair[1].get('timetable_number')]
    if headerless:
        try:
            # Failed boundaries make ordinal inference unsafe.
            if results or issues:
                raise ParseError('cannot number headerless sections alongside failed sections')
            _resolve_headerless_timetables([s for _, s in parsed], source_key=source.source_key,
                source_effective_date=_effective_date_from_source_name(source_name), source_name=source_name)
        except ParseError as exc:
            for boundary, _ in headerless:
                issues.append({'timetable_number': None, 'pages': boundary['pages'], 'error': str(exc)})
            parsed = [pair for pair in parsed if pair not in headerless]
    for boundary, timetable in parsed:
        number = timetable['timetable_number']
        result = {'timetable_number': number, 'pages': boundary['pages']}
        try:
            direction = {'code': number[4:], 'name': timetable['route_title'],
                         'effective_date': timetable['effective_date'],
                         'services': [_canonical_service(label, route, timetable['footnotes'])
                                      for label, route in timetable['services'].items()]}
            bundle = {'routes': [{'code': number[:4], 'directions': [direction]}]}
            extraction = next(split_extraction(bundle))[1]
            result.update(extraction=extraction, content_sha256=content_sha256(extraction))
        except (ValueError, KeyError) as exc:
            result['error'] = str(exc)
        results.append(result)
    by_number = {}
    for result in results:
        number = result['timetable_number']
        existing = by_number.get(number)
        if existing:
            existing['pages'] = sorted(set(existing['pages'] + result['pages']))
            if existing.get('error') or result.get('error') or existing['content_sha256'] != result['content_sha256']:
                existing.pop('extraction', None)
                existing.pop('content_sha256', None)
                existing['error'] = f'conflicting or invalid repeated timetable {number}'
        else:
            by_number[number] = result
    if not by_number and not issues:
        issues.append({'timetable_number': None, 'pages': [], 'error': 'no GABS timetables were parsed'})
    if len(source.source_key) == 6 and source.source_key not in by_number:
        issues.append({'timetable_number': None, 'pages': [],
                       'error': f'catalogue timetable {source.source_key} is absent from this PDF'})
    return {'sections': [by_number[k] for k in sorted(by_number)], 'issues': issues,
            'complete': not issues and not any(s.get('error') for s in by_number.values())}
