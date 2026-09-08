"""Deterministic weekly source-accuracy audit planning."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, replace
from datetime import date, timedelta
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple


MINIMUM_AUDIT_SAMPLE_SIZE = 100
DEFAULT_AUDIT_SAMPLE_SIZE = 200


@dataclass(frozen=True)
class AuditCandidate:
    source_id: int
    source_version_id: int
    operator: str
    route_code: str
    route_name: str
    direction_code: Optional[str]
    direction_name: str
    direction_ordinal: int
    service_day: str
    trip_ordinal: int
    stop_name: str
    stop_sequence: int
    pdf_departure: str
    raw_departure: str
    sample_kind: str
    footnote_markers: Tuple[str, ...]
    expected_departure: Optional[str] = None
    section_version_id: Optional[int] = None

    def identity(self) -> Tuple[Any, ...]:
        return (
            self.source_version_id,
            self.section_version_id,
            self.route_code,
            self.direction_name,
            self.service_day,
            self.trip_ordinal,
            self.stop_sequence,
            self.sample_kind,
        )

    def reconciliation_key(self) -> Tuple[Any, ...]:
        return (
            self.source_version_id,
            self.section_version_id,
            self.route_code.casefold(),
            (self.direction_code or "").casefold(),
            self.direction_name.casefold(),
            self.service_day,
            self.trip_ordinal,
            self.stop_sequence,
            self.stop_name.casefold(),
        )


def iso_week_start(day: Optional[date] = None) -> date:
    selected = day or date.today()
    return selected - timedelta(days=selected.weekday())


def _direction_audit_ordinal(
    operator: str,
    direction_code: Optional[str],
    canonical_ordinal: int,
) -> int:
    # Each GABS source contains multiple embedded directions; the official
    # two-digit direction code is their stable cross-source ordinal.
    if operator == "GABS" and str(direction_code or "").isdigit():
        numeric = int(str(direction_code))
        if numeric > 0:
            return numeric
    return canonical_ordinal


def build_extraction_candidates(
    approved_versions: Iterable[Mapping[str, Any]],
) -> List[AuditCandidate]:
    """Enumerate PDF-derived candidates before production reconciliation."""

    candidates: List[AuditCandidate] = []
    for version in approved_versions:
        extraction = version["extraction"]
        operator = extraction["operator"]
        for route in extraction["routes"]:
            for canonical_direction_ordinal, direction in enumerate(
                route["directions"], start=1
            ):
                direction_ordinal = _direction_audit_ordinal(
                    operator,
                    direction.get("code"),
                    canonical_direction_ordinal,
                )
                flattened_trips: List[
                    Tuple[Mapping[str, Any], Mapping[str, Any], int]
                ] = []
                trip_ordinal = 0
                for service in direction["services"]:
                    for trip in service["trips"]:
                        trip_ordinal += 1
                        flattened_trips.append((service, trip, trip_ordinal))

                by_day: Dict[str, List[Tuple[Mapping[str, Any], Mapping[str, Any], int]]] = {}
                for service, trip, trip_ordinal in flattened_trips:
                    for service_day in trip.get("service_days", service["service_days"]):
                        by_day.setdefault(service_day, []).append(
                            (service, trip, trip_ordinal)
                        )

                boundary_cells: Dict[Tuple[str, int, int], str] = {}
                for service_day, day_trips in by_day.items():
                    if not day_trips:
                        continue
                    first_ordinal = min(item[2] for item in day_trips)
                    last_ordinal = max(item[2] for item in day_trips)
                    first_trip = next(item[1] for item in day_trips if item[2] == first_ordinal)
                    last_trip = next(item[1] for item in day_trips if item[2] == last_ordinal)
                    first_scheduled = next(
                        (
                            cell
                            for cell in first_trip["times"]
                            if cell.get("stop_time_type") == "scheduled" and cell.get("time")
                        ),
                        None,
                    )
                    last_scheduled = next(
                        (
                            cell
                            for cell in reversed(last_trip["times"])
                            if cell.get("stop_time_type") == "scheduled" and cell.get("time")
                        ),
                        None,
                    )
                    if first_scheduled:
                        boundary_cells[
                            (service_day, first_ordinal, first_scheduled["sequence"])
                        ] = "first_departure"
                    if last_scheduled:
                        boundary_cells[
                            (service_day, last_ordinal, last_scheduled["sequence"])
                        ] = "last_departure"

                for service_day, day_trips in by_day.items():
                    for service, trip, ordinal in day_trips:
                        markers = tuple(trip.get("footnote_markers", []))
                        for cell in trip["times"]:
                            if cell.get("stop_time_type") != "scheduled" or not cell.get("time"):
                                continue
                            sample_kind = boundary_cells.get(
                                (service_day, ordinal, cell["sequence"]),
                                "footnote" if markers else "standard",
                            )
                            candidates.append(
                                AuditCandidate(
                                    source_id=int(version["source_id"]),
                                    source_version_id=int(version["source_version_id"]),
                                    section_version_id=version.get("section_version_id"),
                                    operator=operator,
                                    route_code=str(route["code"]),
                                    route_name=str(route["name"]),
                                    direction_code=(
                                        str(direction["code"])
                                        if direction.get("code") is not None
                                        else None
                                    ),
                                    direction_name=str(direction["name"]),
                                    direction_ordinal=direction_ordinal,
                                    service_day=service_day,
                                    trip_ordinal=ordinal,
                                    stop_name=str(cell["stop_name"]),
                                    stop_sequence=int(cell["sequence"]),
                                    pdf_departure=str(cell["time"]),
                                    raw_departure=str(cell.get("raw_time") or ""),
                                    sample_kind=sample_kind,
                                    footnote_markers=markers,
                                )
                            )
    return candidates


def reconcile_with_published(
    candidates: Iterable[AuditCandidate],
    published_rows: Iterable[Mapping[str, Any]],
) -> Tuple[List[AuditCandidate], Dict[str, int]]:
    """Attach the passenger-facing Fika time and exclude unpublished cells."""

    published: Dict[Tuple[Any, ...], str] = {}
    for row in published_rows:
        key = (
            int(row["source_version_id"]),
            row.get("section_version_id"),
            str(row["route_code"]).casefold(),
            str(row.get("direction_code") or "").casefold(),
            str(row["direction_name"]).casefold(),
            str(row["service_day"]),
            int(row["trip_ordinal"]),
            int(row["stop_sequence"]),
            str(row["stop_name"]).casefold(),
        )
        departure = str(row.get("expected_departure") or "")
        if departure:
            published[key] = departure

    reconciled: List[AuditCandidate] = []
    missing = 0
    divergent = 0
    candidate_count = 0
    for candidate in candidates:
        candidate_count += 1
        passenger_time = published.get(candidate.reconciliation_key())
        if not passenger_time:
            missing += 1
            continue
        if passenger_time != candidate.pdf_departure:
            divergent += 1
        reconciled.append(replace(candidate, expected_departure=passenger_time))
    return reconciled, {
        "extraction_candidates": candidate_count,
        "published_candidates": len(reconciled),
        "unpublished_candidates": missing,
        "candidate_production_time_mismatches": divergent,
    }


def _score(seed: str, candidate: AuditCandidate) -> str:
    payload = json.dumps(candidate.identity(), separators=(",", ":"), default=str)
    return hashlib.sha256(f"{seed}|{payload}".encode("utf-8")).hexdigest()


def _coverage_tokens(candidate: AuditCandidate) -> Set[Tuple[Any, ...]]:
    return {
        ("operator", candidate.operator),
        ("direction", candidate.operator, candidate.direction_ordinal),
        ("service_day", candidate.operator, candidate.service_day),
        ("sample_kind", candidate.sample_kind),
    }


def select_stratified_samples(
    candidates: Sequence[AuditCandidate],
    *,
    audit_week: date,
    target_sample_size: int = DEFAULT_AUDIT_SAMPLE_SIZE,
) -> List[AuditCandidate]:
    target = max(MINIMUM_AUDIT_SAMPLE_SIZE, int(target_sample_size))
    unique = {candidate.identity(): candidate for candidate in candidates}
    ordered = sorted(unique.values(), key=lambda item: _score(audit_week.isoformat(), item))
    if len(ordered) < target:
        return ordered

    required: Set[Tuple[Any, ...]] = set()
    for candidate in ordered:
        required.update(_coverage_tokens(candidate))
    selected: List[AuditCandidate] = []
    selected_ids = set()
    uncovered = set(required)
    while uncovered:
        best = max(
            (candidate for candidate in ordered if candidate.identity() not in selected_ids),
            key=lambda candidate: (
                len(_coverage_tokens(candidate) & uncovered),
                _score(audit_week.isoformat(), candidate),
            ),
        )
        selected.append(best)
        selected_ids.add(best.identity())
        uncovered.difference_update(_coverage_tokens(best))

    operators = sorted({candidate.operator for candidate in ordered})
    buckets = {
        operator: [
            candidate
            for candidate in ordered
            if candidate.operator == operator and candidate.identity() not in selected_ids
        ]
        for operator in operators
    }
    bucket_indexes = {operator: 0 for operator in operators}
    counts = {
        operator: sum(candidate.operator == operator for candidate in selected)
        for operator in operators
    }
    while len(selected) < target:
        available = [
            operator
            for operator in operators
            if bucket_indexes[operator] < len(buckets[operator])
        ]
        if not available:
            break
        operator = min(available, key=lambda value: (counts[value], value))
        candidate = buckets[operator][bucket_indexes[operator]]
        bucket_indexes[operator] += 1
        if candidate.identity() in selected_ids:
            continue
        selected.append(candidate)
        selected_ids.add(candidate.identity())
        counts[operator] += 1
    return selected


def plan_compliance(
    selected: Sequence[AuditCandidate],
    available: Sequence[AuditCandidate],
    *,
    target_sample_size: int = DEFAULT_AUDIT_SAMPLE_SIZE,
) -> Dict[str, Any]:
    target = max(MINIMUM_AUDIT_SAMPLE_SIZE, int(target_sample_size))
    selected_operators = {item.operator for item in selected}
    available_operators = {item.operator for item in available}
    missing: List[str] = []
    if len(selected) < target:
        missing.append(f"only {len(selected)} of {target} published samples available")
    if available_operators != {"GABS", "MyCiti"}:
        missing.append("approved and published samples are not available for both operators")
    elif selected_operators != available_operators:
        missing.append("selected samples do not cover both operators")

    available_directions = {
        (item.operator, item.direction_ordinal)
        for item in available
        if item.direction_ordinal in {1, 2}
    }
    selected_directions = {
        (item.operator, item.direction_ordinal) for item in selected
    }
    for operator, ordinal in sorted(available_directions):
        if (operator, ordinal) not in selected_directions:
            missing.append(f"missing {operator} direction ordinal {ordinal}")

    selected_days = {item.service_day for item in selected}
    available_days = {item.service_day for item in available}
    for day in ("saturday", "sunday", "public_holiday"):
        if day in available_days and day not in selected_days:
            missing.append(f"missing {day} sample")
    if len(selected_days) < min(2, len(available_days)):
        missing.append("samples do not cover multiple service days")

    selected_kinds = {item.sample_kind for item in selected}
    available_kinds = {item.sample_kind for item in available}
    for kind in ("first_departure", "last_departure", "footnote"):
        if kind in available_kinds and kind not in selected_kinds:
            missing.append(f"missing {kind} sample")
    return {"compliant": not missing, "shortfalls": missing}


__all__ = [
    "AuditCandidate",
    "DEFAULT_AUDIT_SAMPLE_SIZE",
    "MINIMUM_AUDIT_SAMPLE_SIZE",
    "build_extraction_candidates",
    "iso_week_start",
    "plan_compliance",
    "reconcile_with_published",
    "select_stratified_samples",
]
