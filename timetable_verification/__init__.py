"""Fika timetable source verification pipeline.

The package downloads official timetable publications, produces deterministic
operator-neutral extractions, and stages changed publications for review.  It
never writes to Fika's production route, direction, trip, or stop-time rows.
"""

SCHEMA_VERSION = 1
PARSER_VERSION = "fika-timetable-parser/1.0.0"
GABS_PARSER_VERSION = "fika-gabs-parser/2.0.0"
IMPORT_VERSION = "fika-timetable-canonical/1.0.0"
GABS_IMPORT_VERSION = "fika-gabs-sections/2.0.0"

__all__ = [
    "GABS_PARSER_VERSION",
    "IMPORT_VERSION",
    "PARSER_VERSION",
    "SCHEMA_VERSION",
]
