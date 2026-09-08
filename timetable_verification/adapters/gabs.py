"""Golden Arrow Bus Services official timetable adapter."""

from __future__ import annotations

import heapq
import io
import re
from datetime import date
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import unquote, urlencode, urljoin, urlsplit

import pdfplumber

from timetable_verification import GABS_PARSER_VERSION, SCHEMA_VERSION
from timetable_verification.canonical import (
    footnote_markers,
    normalize_time,
    ordered_service_days,
    stop_time_type,
    validate_extraction,
)

from .base import DiscoveredSource, DiscoveryError, OperatorAdapter, ParseError


GABS_CATALOGUE_URL = "https://www.gabs.co.za/Timetable.aspx"
# Cloudflare currently rejects ASP.NET catalogue postbacks from a non-browser
# User-Agent with HTTP 403.  Keep the proven browser-compatible header limited
# to this catalogue while identifying the paced verifier separately. PDF
# downloads continue to use the global descriptive verifier User-Agent.
GABS_CATALOGUE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) "
        "Gecko/20100101 Firefox/128.0"
    ),
    "X-Fika-Verifier": (
        "Fika-Timetable-Verifier/1.0; contact=https://www.fika.net.za/contact"
    ),
}
SERVICE_DAY_MAP = {
    "MONDAYS TO FRIDAYS": [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
    ],
    "SATURDAYS": ["saturday"],
    "SUNDAYS": ["sunday"],
    "PUBLIC HOLIDAYS": ["public_holiday"],
}
SERVICE_HEADERS = tuple(SERVICE_DAY_MAP)
_NUMBER_RE = re.compile(
    r"Timetable\s+Number\s*-\s*([0-9][0-9\s]{2,}[0-9]|[0-9]+)",
    re.IGNORECASE,
)
_PDF_PATH_RE = re.compile(
    r"""window\.open\(\s*['"]([^'"]+\.pdf(?:\?[^'"]*)?)['"]""",
    re.IGNORECASE,
)
_FILE_KEY_RE = re.compile(r"_(\d{5,6})\.pdf$", re.IGNORECASE)
_FILE_EFFECTIVE_DATE_RE = re.compile(
    r"(?:_from_|_PH_)(\d{4})(\d{2})(\d{2})(?:_|\.)",
    re.IGNORECASE,
)
_RESULT_RE = re.compile(r"Results\s+for\s+([A-Za-z]+)\s+(\d+)", re.IGNORECASE)
_HEADER_RE = re.compile(
    r"(MONDAYS TO FRIDAYS|SATURDAYS|SUNDAYS|PUBLIC HOLIDAYS).*?"
    r"EFFECTIVE DATE:\s*(\d{4}/\d{2}/\d{2}).*?"
    r"TIMETABLE NUMBER:\s*(\d{4})\s*(\d{2})",
    re.IGNORECASE,
)


def normalize_source_key(value: str) -> str:
    digits = re.sub(r"\D", "", str(value or ""))
    if len(digits) not in {5, 6}:
        raise ParseError(f"invalid GABS timetable number {value!r}")
    return digits


def _effective_date_from_source_name(source_name: str) -> Optional[str]:
    match = _FILE_EFFECTIVE_DATE_RE.search(source_name)
    if not match:
        return None
    try:
        return date(
            int(match.group(1)),
            int(match.group(2)),
            int(match.group(3)),
        ).isoformat()
    except ValueError as exc:
        raise ParseError(
            f"{source_name}: invalid effective date in official PDF filename"
        ) from exc


def _source_key_from_pdf_url(url: str) -> Optional[str]:
    filename = Path(unquote(urlsplit(url).path)).name
    match = _FILE_KEY_RE.search(filename)
    return match.group(1) if match else None


def _source_url_priority(url: str) -> Tuple[str, str]:
    """Prefer the newest effective filename while retaining deterministic ties."""

    filename = Path(unquote(urlsplit(url).path)).name
    match = _FILE_EFFECTIVE_DATE_RE.search(filename)
    effective = "".join(match.groups()) if match else ""
    return effective, url


def _select_preferred_source(
    sources: Sequence[DiscoveredSource],
) -> DiscoveredSource:
    unique_by_url = {source.url: source for source in sources}
    ordered = sorted(unique_by_url.values(), key=lambda item: _source_url_priority(item.url))
    selected = ordered[-1]
    if len(ordered) == 1:
        return selected
    alternate_urls = tuple(item.url for item in ordered[:-1])
    warning = (
        f"catalogue key {selected.source_key} has {len(ordered)} official PDF URLs; "
        "selected the newest filename effective date and retained the others "
        "for review evidence"
    )
    return DiscoveredSource(
        operator=selected.operator,
        source_key=selected.source_key,
        url=selected.url,
        catalogue_page=selected.catalogue_page,
        route_name_hint=selected.route_name_hint,
        alternate_urls=alternate_urls,
        discovery_warnings=(warning,),
    )


class _CatalogueParser(HTMLParser):
    def __init__(self, source_page: str = "") -> None:
        super().__init__(convert_charrefs=True)
        self.source_page = source_page
        self.hidden_fields: Dict[str, str] = {}
        self.page_ids: List[str] = []
        self.result_text_parts: List[str] = []
        self.sources: List[DiscoveredSource] = []
        self.malformed_count = 0
        self._result_depth = 0
        self._card_depth = 0
        self._card_text_parts: List[str] = []
        self._route_text_parts: List[str] = []
        self._route_open = False
        self._route_captured = False
        self._download_onclick = ""

    def handle_starttag(self, tag: str, attrs_list: Sequence[tuple]) -> None:
        attrs = {name: value or "" for name, value in attrs_list}
        classes = attrs.get("class", "").split()
        if tag == "input" and attrs.get("type", "").casefold() == "hidden":
            name = attrs.get("name")
            if name:
                self.hidden_fields[name] = attrs.get("value", "")
        if tag == "button" and "letters" in classes:
            page_id = attrs.get("id", "").strip()
            if page_id and page_id.casefold() != "all":
                self.page_ids.append(page_id)
        if tag == "div" and attrs.get("id") == "Results":
            self._result_depth = 1
        elif self._result_depth and tag == "div":
            self._result_depth += 1
        if tag == "div" and "TimeTableDownloadContainer" in classes:
            self._card_depth = 1
            self._card_text_parts = []
            self._route_text_parts = []
            self._route_open = False
            self._route_captured = False
            self._download_onclick = ""
            return
        if not self._card_depth:
            return
        if tag == "div":
            self._card_depth += 1
            if self._card_depth == 2 and not self._route_captured:
                self._route_open = True
        if tag == "button" and attrs.get("title") == "Download":
            self._download_onclick = attrs.get("onclick", "")

    def handle_data(self, data: str) -> None:
        if self._result_depth:
            self.result_text_parts.append(data)
        if self._card_depth:
            self._card_text_parts.append(data)
            if self._route_open:
                self._route_text_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if self._card_depth and tag == "div":
            if self._card_depth == 2 and self._route_open:
                self._route_open = False
                self._route_captured = True
            self._card_depth -= 1
            if self._card_depth == 0:
                self._finish_card()
        if self._result_depth and tag == "div":
            self._result_depth -= 1

    @property
    def result_text(self) -> str:
        return " ".join("".join(self.result_text_parts).split())

    @property
    def page_label(self) -> str:
        match = _RESULT_RE.search(self.result_text)
        return match.group(1) if match else ""

    @property
    def advertised_card_count(self) -> Optional[int]:
        match = _RESULT_RE.search(self.result_text)
        return int(match.group(2)) if match else None

    def _finish_card(self) -> None:
        card_text = " ".join("".join(self._card_text_parts).split())
        route_name = " ".join("".join(self._route_text_parts).split())
        number_match = _NUMBER_RE.search(card_text)
        pdf_match = _PDF_PATH_RE.search(self._download_onclick)
        if not number_match or not pdf_match:
            self.malformed_count += 1
            return
        pdf_url = urljoin(self.source_page or GABS_CATALOGUE_URL, pdf_match.group(1))
        url_key = _source_key_from_pdf_url(pdf_url)
        card_digits = re.sub(r"\D", "", number_match.group(1))
        if url_key:
            source_key = url_key
            if len(card_digits) in {5, 6} and card_digits != source_key:
                self.malformed_count += 1
                return
        elif len(card_digits) in {5, 6}:
            source_key = card_digits
        else:
            self.malformed_count += 1
            return
        self.sources.append(
            DiscoveredSource(
                operator="GABS",
                source_key=source_key,
                url=pdf_url,
                catalogue_page=self.source_page or GABS_CATALOGUE_URL,
                route_name_hint=route_name,
            )
        )


def _parse_catalogue(html: str, source_page: str = "") -> _CatalogueParser:
    parser = _CatalogueParser(source_page)
    parser.feed(html)
    parser.close()
    return parser


def _validate_catalogue_page(page: _CatalogueParser, requested_page_id: str) -> None:
    if page.page_label.casefold() != requested_page_id.casefold():
        raise DiscoveryError(
            f"expected GABS page {requested_page_id}, got "
            f"{page.page_label or 'an unlabelled page'}"
        )
    advertised = page.advertised_card_count
    if advertised is None:
        raise DiscoveryError(f"GABS page {requested_page_id} has no result count")
    actual = len(page.sources) + page.malformed_count
    if actual != advertised or page.malformed_count:
        raise DiscoveryError(
            f"GABS page {requested_page_id} advertised {advertised} cards but "
            f"contained {len(page.sources)} valid and {page.malformed_count} malformed cards"
        )


def _is_probable_title(line: str) -> bool:
    stripped = line.strip()
    upper = stripped.upper()
    if " - " not in stripped:
        return False
    if any(upper.startswith(header) for header in SERVICE_HEADERS):
        return False
    if "TIMETABLE NUMBER" in upper or "EFFECTIVE DATE" in upper:
        return False
    if stripped.startswith("|") or set(stripped) == {"-"}:
        return False
    return bool(re.search(r"[A-Z]", upper))


def _collect_service_rows(lines: Sequence[str], start: int) -> List[str]:
    rows: List[str] = []
    index = start
    while index < len(lines):
        line = lines[index].rstrip()
        if line.startswith("|") or set(line.strip()) == {"-"}:
            rows.append(line)
            index += 1
        else:
            break
    return rows


def _is_separator_row(row: str) -> bool:
    return set(row.replace("|", "").strip()) == {"-"}


def _parse_group(rows: Sequence[str]) -> Dict[str, Any]:
    parsed_rows: List[Tuple[str, List[str]]] = []
    max_columns = 0
    for row in rows:
        if not row.rstrip().endswith('|'):
            raise ParseError('GABS timetable contains an incomplete table row')
        columns = [column.strip() for column in row.split("|")[1:-1]]
        if not columns:
            continue
        stop = columns[0]
        times = columns[1:]
        for raw in times:
            if not normalize_time(raw) and raw.casefold() not in {'', '-', '--', 'via'}:
                raise ParseError(f'GABS timetable contains an unrecognized cell {raw!r}')
        if not stop:
            raise ParseError("GABS timetable contains a blank stop name")
        parsed_rows.append((stop, times))
        max_columns = max(max_columns, len(times))
    return {"rows": parsed_rows, "max_columns": max_columns}


def _merge_stop_sequences(stop_paths: Sequence[Sequence[str]]) -> List[str]:
    """Return one deterministic order satisfying every PDF block's order.

    A GABS service can split trips into horizontal blocks whose stop lists are
    different branches of the same direction.  Every adjacent pair printed in
    a block is an ordering constraint.  First appearance in the PDF breaks ties
    between otherwise independent branches, so the first block remains the
    ordering spine.  Contradictory blocks are quarantined instead of silently
    inventing an order.
    """

    first_seen: Dict[str, int] = {}
    edges: Dict[str, set[str]] = {}
    indegree: Dict[str, int] = {}
    next_ordinal = 0

    for path in stop_paths:
        path_seen = set()
        for stop in path:
            if stop in path_seen:
                raise ParseError(
                    f"GABS service block repeats stop {stop!r}; cannot prove one stop order"
                )
            path_seen.add(stop)
            if stop not in first_seen:
                first_seen[stop] = next_ordinal
                next_ordinal += 1
                edges[stop] = set()
                indegree[stop] = 0
        for previous, following in zip(path, path[1:]):
            if following not in edges[previous]:
                edges[previous].add(following)
                indegree[following] += 1

    available = [
        (first_seen[stop], stop)
        for stop, count in indegree.items()
        if count == 0
    ]
    heapq.heapify(available)
    ordered: List[str] = []
    while available:
        _ordinal, stop = heapq.heappop(available)
        ordered.append(stop)
        for following in sorted(edges[stop], key=first_seen.__getitem__):
            indegree[following] -= 1
            if indegree[following] == 0:
                heapq.heappush(available, (first_seen[following], following))

    if len(ordered) != len(first_seen):
        unresolved = sorted(
            (stop for stop, count in indegree.items() if count > 0),
            key=first_seen.__getitem__,
        )
        raise ParseError(
            "GABS service blocks contain contradictory stop orders involving "
            + ", ".join(unresolved)
        )
    return ordered


def _parse_route_rows(rows: Sequence[str]) -> Dict[str, Any]:
    groups: List[List[str]] = []
    current: List[str] = []
    for row in rows:
        if _is_separator_row(row):
            if current:
                groups.append(current)
                current = []
        else:
            current.append(row)
    if current:
        groups.append(current)
    parsed_groups = [_parse_group(group) for group in groups if group]
    if not parsed_groups:
        raise ParseError("GABS service table contained no data rows")
    stop_paths = [
        [stop for stop, _times in group["rows"]]
        for group in parsed_groups
    ]
    stops = _merge_stop_sequences(stop_paths)
    trips: List[List[Dict[str, str]]] = []
    for group in parsed_groups:
        for column in range(group["max_columns"]):
            raw_by_stop = {
                stop: times[column] if column < len(times) and times[column] else "--"
                for stop, times in group["rows"]
            }
            if not any(normalize_time(raw) for raw in raw_by_stop.values()):
                continue
            trips.append(
                [
                    {"stop_name": stop, "raw_time": raw_by_stop.get(stop, "--")}
                    for stop in stops
                ]
            )
    trips.sort(
        key=lambda trip: next(
            (normalize_time(item["raw_time"]) for item in trip if normalize_time(item["raw_time"])),
            "99:99",
        )
    )
    if not trips:
        raise ParseError("GABS service table contained no scheduled trips")
    return {"stops": stops, "stop_paths": stop_paths, "trips": trips}


def _merge_service_route(existing: Dict[str, Any], continuation: Dict[str, Any]) -> None:
    stop_paths = [
        *existing.get("stop_paths", [existing["stops"]]),
        *continuation.get("stop_paths", [continuation["stops"]]),
    ]
    all_stops = _merge_stop_sequences(stop_paths)

    def expand(trip: List[Dict[str, str]]) -> List[Dict[str, str]]:
        by_stop = {item["stop_name"]: item["raw_time"] for item in trip}
        return [
            {"stop_name": stop, "raw_time": by_stop.get(stop, "--")}
            for stop in all_stops
        ]

    existing["trips"] = [expand(trip) for trip in existing["trips"]]
    existing["trips"].extend(expand(trip) for trip in continuation["trips"])
    existing["trips"].sort(
        key=lambda trip: next(
            (normalize_time(item["raw_time"]) for item in trip if normalize_time(item["raw_time"])),
            "99:99",
        )
    )
    existing["stops"] = all_stops
    existing["stop_paths"] = stop_paths


def _deduplicate_identical_timetables(
    timetables: Sequence[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Coalesce repeated PDF pages only when their parsed content is identical."""

    unique: List[Dict[str, Any]] = []
    for timetable in timetables:
        if any(existing == timetable for existing in unique):
            continue
        unique.append(timetable)
    return unique


def _resolve_headerless_timetables(
    timetables: List[Dict[str, Any]],
    *,
    source_key: str,
    source_effective_date: Optional[str],
    source_name: str,
) -> None:
    """Resolve official GABS sections whose generated PDF omits its header.

    GABS PDFs normally order direction 01, 02, and so on by section. Some
    weekend-only documents omit the number/date header entirely. The official
    catalogue key remains authoritative for its matching section. A filename
    effective date is applied only to that source section; another embedded
    direction without a printed date remains null.
    """

    normalized_source_key = normalize_source_key(source_key)
    route_code = normalized_source_key[:4]
    explicit_keys: List[str] = []
    for timetable in timetables:
        number = timetable.get("timetable_number")
        effective_date = timetable.get("effective_date")
        if bool(number) != bool(effective_date):
            raise ParseError(
                f"{source_name}: partially populated GABS timetable header"
            )
        if number:
            normalized = normalize_source_key(number)
            if len(normalized) != 6:
                raise ParseError(
                    f"{source_name}: printed timetable number must have six digits"
                )
            if normalized[:4] != route_code and any(not t.get("timetable_number") for t in timetables):
                raise ParseError(
                    f"{source_name}: embedded route {normalized[:4]} does not match "
                    f"catalogue route {route_code}"
                )
            explicit_keys.append(normalized)

    assigned = set(explicit_keys)
    missing_indexes = [
        index
        for index, timetable in enumerate(timetables)
        if not timetable.get("timetable_number")
    ]
    if missing_indexes and len(normalized_source_key) == 5:
        raise ParseError(
            f"{source_name}: official five-digit bundle key "
            f"{normalized_source_key} cannot identify the direction of a "
            "headerless timetable section"
        )
    if missing_indexes and len(timetables) > 1:
        endpoints = []
        for timetable in timetables:
            parts = [part.strip().casefold() for part in timetable['route_title'].split(' - ') if part.strip()]
            endpoints.append(frozenset((parts[0], parts[-1])))
        if len(set(endpoints)) != 1:
            raise ParseError(f'{source_name}: cannot prove headerless sections belong to one route; explicit timetable numbers are required')
    for index in missing_indexes:
        timetable = timetables[index]
        if not timetable.get("services"):
            raise ParseError(
                f"{source_name}: headerless timetable section has no service table"
            )
        if len(timetables) == 1:
            candidate = normalized_source_key
        else:
            ordinal_candidate = f"{route_code}{index + 1:02d}"
            if ordinal_candidate not in assigned:
                candidate = ordinal_candidate
            elif normalized_source_key not in assigned and len(missing_indexes) == 1:
                candidate = normalized_source_key
            else:
                raise ParseError(
                    f"{source_name}: cannot unambiguously number headerless "
                    f"timetable section {index + 1}"
                )
        if candidate in assigned:
            raise ParseError(
                f"{source_name}: inferred duplicate GABS timetable number {candidate}"
            )
        timetable["timetable_number"] = candidate
        timetable["effective_date"] = (
            source_effective_date if candidate == normalized_source_key else None
        )
        assigned.add(candidate)


def _parse_pdf_timetables(
    pdf_bytes: bytes,
    source_name: str,
    *,
    source_key: Optional[str] = None,
    source_effective_date: Optional[str] = None,
) -> List[Dict[str, Any]]:
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            lines: List[str] = []
            titles: List[str] = []
            for page in pdf.pages:
                text = page.extract_text() or ""
                page_lines = text.splitlines()
                lines.extend(page_lines)
                for line in page_lines:
                    if _is_probable_title(line):
                        title = line.strip().upper()
                        if title not in titles:
                            titles.append(title)
    except Exception as exc:
        raise ParseError(f"could not read GABS PDF {source_name}: {exc}") from exc

    return _parse_timetable_lines(lines, source_name, source_key=source_key,
                                  source_effective_date=source_effective_date)


def _parse_timetable_lines(lines, source_name, *, source_key=None,
                           source_effective_date=None, allow_headerless=False):
    titles = {line.strip().upper() for line in lines if _is_probable_title(line)}
    parsed: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None
    current_service: Optional[str] = None

    def finish_current() -> None:
        nonlocal current
        if not current:
            return
        if not any(
            current.get(field)
            for field in ("timetable_number", "effective_date", "services")
        ):
            # PDF footer slogans can resemble a route title because they use
            # uppercase text around a hyphen; they are not timetable sections.
            current = None
            return
        required_fields = ("route_title", "services")
        missing_fields = [field for field in required_fields if not current.get(field)]
        if missing_fields:
            raise ParseError(
                f"{source_name}: incomplete GABS timetable section "
                f"{current.get('timetable_number') or current.get('route_title') or '?'} "
                f"(missing {', '.join(missing_fields)})"
            )
        parsed.append(current)
        current = None

    index = 0
    while index < len(lines):
        line = lines[index]
        upper = line.strip().upper()
        if upper in titles:
            if current is None:
                current = {
                    "route_title": upper,
                    "timetable_number": None,
                    "effective_date": None,
                    "services": {},
                    "footnotes": {},
                }
            elif upper != current["route_title"]:
                finish_current()
                current_service = None
                current = {
                    "route_title": upper,
                    "timetable_number": None,
                    "effective_date": None,
                    "services": {},
                    "footnotes": {},
                }

        header = _HEADER_RE.search(line)
        if header:
            if current is None:
                index += 1
                continue
            number = header.group(3) + header.group(4)
            if current.get("timetable_number") and current["timetable_number"] != number:
                title = current["route_title"]
                finish_current()
                current_service = None
                current = {
                    "route_title": title,
                    "timetable_number": None,
                    "effective_date": None,
                    "services": {},
                    "footnotes": {},
                }
            current_service = header.group(1).upper()
            current["effective_date"] = header.group(2).replace("/", "-")
            current["timetable_number"] = number
        elif upper in SERVICE_HEADERS:
            current_service = upper
        elif line.startswith("|") and current is not None and current_service:
            rows = _collect_service_rows(lines, index)
            route = _parse_route_rows(rows)
            if current_service in current["services"]:
                _merge_service_route(current["services"][current_service], route)
            else:
                current["services"][current_service] = route
            index += len(rows) - 1
        elif upper == "ABBREVIATIONS" and current is not None:
            index += 1
            while index < len(lines):
                abbreviation = lines[index].strip()
                match = re.match(r"([A-Za-z*#\u2020\u2021])\s*-\s*(.+)", abbreviation)
                if not match:
                    index -= 1
                    break
                marker = match.group(1).casefold()
                text = " ".join(match.group(2).split())
                if marker in current["footnotes"] and current["footnotes"][marker] != text:
                    raise ParseError(
                        f"{source_name}: conflicting definition for GABS footnote {marker!r}"
                    )
                current["footnotes"][marker] = text
                index += 1
        index += 1
    finish_current()

    if source_key is not None:
        _resolve_headerless_timetables(
            parsed,
            source_key=source_key,
            source_effective_date=source_effective_date,
            source_name=source_name,
        )
    elif not allow_headerless and any(not timetable.get("timetable_number") for timetable in parsed):
        raise ParseError(
            f"{source_name}: headerless timetable requires an official source key"
        )
    return _deduplicate_identical_timetables(parsed)


def _route_name(route_title: str) -> str:
    names = [part.strip() for part in route_title.split(" - ") if part.strip()]
    return f"{names[0]} - {names[-1]}" if len(names) >= 2 else route_title


def _footnote_service_days(description: str) -> List[str]:
    normalized = description.casefold()
    aliases = [
        ("monday", "monday"),
        ("tuesday", "tuesday"),
        ("wednesday", "wednesday"),
        ("thursday", "thursday"),
        ("friday", "friday"),
        ("saturday", "saturday"),
        ("sunday", "sunday"),
        ("public holiday", "public_holiday"),
    ]
    order = [canonical for _phrase, canonical in aliases]
    phrase_pattern = "|".join(re.escape(phrase) for phrase, _canonical in aliases)
    lookup = dict(aliases)
    days = set()
    range_pattern = re.compile(
        rf"\b({phrase_pattern})s?\s*(?:to|[-\u2013\u2014])\s*({phrase_pattern})s?\b"
    )
    for match in range_pattern.finditer(normalized):
        start = order.index(lookup[match.group(1)])
        end = order.index(lookup[match.group(2)])
        if start > end:
            raise ParseError(f"ambiguous reverse GABS footnote day range {description!r}")
        days.update(order[start : end + 1])
    without_ranges = range_pattern.sub("", normalized)
    for phrase, canonical in aliases:
        if re.search(rf"\b{re.escape(phrase)}s?\b", without_ranges):
            days.add(canonical)
    residual = without_ranges
    for phrase, _canonical in aliases:
        residual = re.sub(rf"\b{re.escape(phrase)}s?\b", "", residual)
    residual = re.sub(r"\b(?:and|on|only)\b", "", residual)
    residual = re.sub(r"[\s,;/&]+", "", residual)
    if residual:
        raise ParseError(f"ambiguous GABS footnote day wording {description!r}")
    return ordered_service_days(days)


def _canonical_service(
    label: str,
    route: Mapping[str, Any],
    footnotes: Mapping[str, str],
) -> Dict[str, Any]:
    canonical_trips: List[Dict[str, Any]] = []
    base_service_days = ordered_service_days(SERVICE_DAY_MAP[label])
    for trip in route["trips"]:
        markers: List[str] = []
        times: List[Dict[str, Any]] = []
        for sequence, item in enumerate(trip):
            raw = item["raw_time"]
            if normalize_time(raw) and not re.fullmatch(
                r"\s*\d{1,2}:\d{2}\s*[A-Za-z*#\u2020\u2021]*\s*",
                str(raw),
            ):
                raise ParseError(f"unsupported GABS time suffix in {raw!r}")
            for marker in footnote_markers(raw):
                if marker not in markers:
                    markers.append(marker)
            times.append(
                {
                    "sequence": sequence,
                    "stop_name": item["stop_name"],
                    "time": normalize_time(raw),
                    "raw_time": raw,
                    "stop_time_type": stop_time_type(raw),
                }
            )
        unknown = [marker for marker in markers if marker not in footnotes]
        if unknown:
            raise ParseError(
                f"GABS trip uses undefined footnote marker(s): {', '.join(unknown)}"
            )
        restricted_days = {
            day
            for marker in markers
            for day in _footnote_service_days(footnotes[marker])
        }
        if markers and not restricted_days:
            raise ParseError(
                "GABS footnote-marked trip has no machine-readable service days"
            )
        trip_days = ordered_service_days(restricted_days or base_service_days)
        if not set(trip_days).issubset(base_service_days):
            raise ParseError(
                f"GABS footnote days {trip_days} fall outside service {label}"
            )
        canonical_trips.append(
            {
                "footnote_markers": markers,
                "service_days": trip_days,
                "times": times,
            }
        )
    return {
        "label": label,
        "service_days": base_service_days,
        "footnotes": [
            {"marker": marker, "text": footnotes[marker]}
            for marker in sorted(footnotes)
        ],
        "trips": canonical_trips,
    }


class GabsAdapter(OperatorAdapter):
    operator = "GABS"
    parser_version = GABS_PARSER_VERSION

    def __init__(self, catalogue_url: str = GABS_CATALOGUE_URL) -> None:
        self.catalogue_url = catalogue_url

    def discover(self, requester: Any) -> List[DiscoveredSource]:
        initial_response = requester.get(
            self.catalogue_url,
            headers=GABS_CATALOGUE_HEADERS,
            accept="text/html,*/*;q=0.8",
        )
        current = _parse_catalogue(
            initial_response.body.decode("utf-8", errors="replace"),
            self.catalogue_url,
        )
        page_ids = list(dict.fromkeys(current.page_ids))
        if not page_ids:
            raise DiscoveryError("GABS catalogue exposed no timetable letter pages")
        discovered: List[DiscoveredSource] = []
        for page_id in page_ids:
            if current.page_label.casefold() != page_id.casefold():
                form_fields = dict(current.hidden_fields)
                form_fields["__EVENTTARGET"] = page_id
                form_fields["__EVENTARGUMENT"] = ""
                response = requester.post(
                    self.catalogue_url,
                    urlencode(form_fields).encode("utf-8"),
                    headers={
                        **GABS_CATALOGUE_HEADERS,
                        "Content-Type": "application/x-www-form-urlencoded",
                        "Referer": self.catalogue_url,
                    },
                    accept="text/html,*/*;q=0.8",
                )
                current = _parse_catalogue(
                    response.body.decode("utf-8", errors="replace"),
                    self.catalogue_url,
                )
            _validate_catalogue_page(current, page_id)
            discovered.extend(current.sources)

        by_key: Dict[str, List[DiscoveredSource]] = {}
        for source in discovered:
            by_key.setdefault(source.source_key, []).append(source)
        if not by_key:
            raise DiscoveryError("GABS catalogue contained no timetable sources")
        return [
            _select_preferred_source(by_key[source_key])
            for source_key in sorted(by_key)
        ]

    def parse_document(self, source: DiscoveredSource, pdf_bytes: bytes) -> Dict[str, Any]:
        from timetable_verification.sections import parse_gabs_document
        return parse_gabs_document(source, pdf_bytes)

    def parse_pdf(self, source: DiscoveredSource, pdf_bytes: bytes) -> Dict[str, Any]:
        """Strict aggregate compatibility API; the checker uses parse_document."""
        document = self.parse_document(source, pdf_bytes)
        failures = [s["error"] for s in document["sections"] if s.get("error")]
        failures.extend(issue["error"] for issue in document["issues"])
        if failures:
            raise ParseError("; ".join(failures))
        routes = {}
        for section in document["sections"]:
            route = section["extraction"]["routes"][0]
            existing = routes.setdefault(route["code"], {**route, "directions": []})
            existing["directions"].extend(route["directions"])
            if section["timetable_number"] == source.source_key:
                existing["name"] = route["name"]
        if not routes:
            raise ParseError("no GABS timetables were parsed")
        extraction = {
            "schema_version": SCHEMA_VERSION, "operator": self.operator,
            "source_key": source.source_key, "publication_scope": "service_days",
            "effective_date": max((s["extraction"]["effective_date"] for s in document["sections"]
                                   if s["extraction"]["effective_date"]), default=None),
            "routes": list(routes.values()),
        }
        validate_extraction(extraction)
        return extraction


__all__ = [
    "GABS_CATALOGUE_URL",
    "GABS_CATALOGUE_HEADERS",
    "GabsAdapter",
    "SERVICE_DAY_MAP",
    "normalize_source_key",
]
