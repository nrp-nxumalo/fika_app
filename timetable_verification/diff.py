"""Deterministic comparisons between immutable canonical extractions."""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional, Tuple

from .canonical import iter_scheduled_entries


def _entry_description(key: Tuple[Any, ...]) -> Dict[str, Any]:
    return {
        "route_ordinal": key[0] + 1,
        "route_code": key[1],
        "direction_ordinal": key[2] + 1,
        "direction_code": key[3],
        "direction_name": key[4],
        "service_ordinal": key[5] + 1,
        "service_label": key[6],
        "trip_ordinal": key[7] + 1,
        "stop_sequence": key[8],
        "stop_name": key[9],
    }


def _structural_inventory(extraction: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    if not extraction:
        return {
            "routes": [],
            "directions": [],
            "service_days": [],
            "stops": [],
            "footnotes": [],
            "trip_patterns": [],
        }
    routes: List[Dict[str, Any]] = []
    directions: List[Dict[str, Any]] = []
    service_days: List[Dict[str, Any]] = []
    stops: List[Dict[str, Any]] = []
    footnotes: List[Dict[str, Any]] = []
    trip_patterns = []
    for route_ordinal, route in enumerate(extraction.get("routes", []), start=1):
        route_ref = {
            "route_ordinal": route_ordinal,
            "code": route.get("code"),
            "name": route.get("name"),
        }
        routes.append(route_ref)
        for direction_ordinal, direction in enumerate(route.get("directions", []), start=1):
            direction_ref = {
                "route_ordinal": route_ordinal,
                "direction_ordinal": direction_ordinal,
                "code": direction.get("code"),
                "name": direction.get("name"),
                "effective_date": direction.get("effective_date"),
            }
            directions.append(direction_ref)
            for service_ordinal, service in enumerate(direction.get("services", []), start=1):
                context = {
                    "route_ordinal": route_ordinal,
                    "direction_ordinal": direction_ordinal,
                    "service_ordinal": service_ordinal,
                    "label": service.get("label"),
                }
                service_days.append(
                    {**context, "days": list(service.get("service_days", []))}
                )
                footnotes.append(
                    {**context, "definitions": list(service.get("footnotes", []))}
                )
                stop_rows: List[Dict[str, Any]] = []
                trips = service.get("trips", [])
                if trips:
                    stop_rows = [
                        {
                            "sequence": cell.get("sequence"),
                            "stop_name": cell.get("stop_name"),
                        }
                        for cell in trips[0].get("times", [])
                    ]
                stops.append({**context, "stops": stop_rows})
                trip_patterns.append({**context, "trips": [
                    {"service_days": trip.get("service_days", service["service_days"]),
                     "markers": trip.get("footnote_markers", []),
                     "stops": [cell.get("stop_time_type") for cell in trip.get("times", [])]}
                    for trip in trips]})
    return {
        "routes": routes,
        "directions": directions,
        "service_days": service_days,
        "stops": stops,
        "footnotes": footnotes,
        "trip_patterns": trip_patterns,
    }


def compare_extractions(
    previous: Optional[Dict[str, Any]],
    current: Dict[str, Any],
) -> Dict[str, Any]:
    """Compare counts, cells, and review-relevant structure.

    Logical stop-time keys include ordinals so duplicate clock values and stops
    remain distinct.  Added/removed cells are reported separately from cells
    whose clock time changed in place.
    """

    previous_entries = dict(iter_scheduled_entries(previous or {}))
    current_entries = dict(iter_scheduled_entries(current))
    previous_keys = set(previous_entries)
    current_keys = set(current_entries)
    added_keys = sorted(current_keys - previous_keys, key=repr)
    removed_keys = sorted(previous_keys - current_keys, key=repr)
    common_keys = sorted(previous_keys & current_keys, key=repr)

    changed_times: List[Dict[str, Any]] = []
    for key in common_keys:
        previous_time = previous_entries[key].get("time")
        current_time = current_entries[key].get("time")
        if previous_time != current_time:
            changed_times.append(
                {
                    **_entry_description(key),
                    "previous_time": previous_time,
                    "current_time": current_time,
                }
            )

    previous_structure = _structural_inventory(previous)
    current_structure = _structural_inventory(current)
    structural_changes: Dict[str, Dict[str, Any]] = {}
    for category in ("routes", "directions", "service_days", "stops", "footnotes", "trip_patterns"):
        before = previous_structure[category]
        after = current_structure[category]
        structural_changes[category] = {
            "changed": before != after,
            "previous": before,
            "current": after,
        }

    result = {
        "has_previous_version": previous is not None,
        "previous_scheduled_departure_count": len(previous_entries),
        "current_scheduled_departure_count": len(current_entries),
        "scheduled_departure_count_delta": len(current_entries) - len(previous_entries),
        "changed_time_count": len(changed_times),
        "added_time_count": len(added_keys),
        "removed_time_count": len(removed_keys),
        "changed_times": changed_times,
        "added_times": [
            {
                **_entry_description(key),
                "current_time": current_entries[key].get("time"),
            }
            for key in added_keys
        ],
        "removed_times": [
            {
                **_entry_description(key),
                "previous_time": previous_entries[key].get("time"),
            }
            for key in removed_keys
        ],
        "structural_changes": structural_changes,
    }
    result["has_changes"] = (
        previous is None
        or result["scheduled_departure_count_delta"] != 0
        or result["changed_time_count"] != 0
        or result["added_time_count"] != 0
        or result["removed_time_count"] != 0
        or any(change["changed"] for change in structural_changes.values())
    )
    return result


__all__ = ["compare_extractions"]
