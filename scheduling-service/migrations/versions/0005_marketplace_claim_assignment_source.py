"""Module 07 Phase 5 (docs/adr/0089) - `assignment_source` gains a `claim`
value

0001's `_ASSIGNMENT_SOURCES` (`auto_generated`, `manual_override`, `swap`,
`bid`) had no value for a plain open-shift claim - `swap`/`bid` are each
already spoken for by their own marketplace mechanism (a peer-to-peer
trade, a ranked bid win), and reusing either for a first-come-first-served
claim would misrepresent *how* the assignment came to be, defeating the
whole point of this column existing (ADR-0058's own "restore the real
assignment_source... instead of defaulting every assignment to
auto_generated" reasoning, applied one value short). `locked` (`GENERATED
ALWAYS AS (assignment_source <> 'auto_generated')`) is unaffected - a
`claim` value is still `<> 'auto_generated'`, so it locks exactly like
`manual_override`/`swap`/`bid` already do, no separate change needed
there.

The existing CHECK constraint on `scheduling.shift_assignments.
assignment_source` was inline/unnamed at 0001 (Postgres auto-generated a
name) - looked up dynamically by definition rather than guessing that
generated name, then replaced with an explicitly-named one so a future
migration never has to repeat this lookup.
"""

from __future__ import annotations

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

_OLD_ASSIGNMENT_SOURCES = ("auto_generated", "manual_override", "swap", "bid")
_NEW_ASSIGNMENT_SOURCES = ("auto_generated", "manual_override", "swap", "bid", "claim")


def upgrade() -> None:
    _replace_assignment_source_check(_NEW_ASSIGNMENT_SOURCES)


def downgrade() -> None:
    _replace_assignment_source_check(_OLD_ASSIGNMENT_SOURCES)


def _replace_assignment_source_check(values: tuple[str, ...]) -> None:
    op.execute(
        """
        DO $$
        DECLARE
          con_name text;
        BEGIN
          SELECT conname INTO con_name
          FROM pg_constraint
          WHERE conrelid = 'scheduling.shift_assignments'::regclass
            AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%assignment_source%';
          IF con_name IS NOT NULL THEN
            EXECUTE format('ALTER TABLE scheduling.shift_assignments DROP CONSTRAINT %I', con_name);
          END IF;
        END $$;
        """
    )
    op.execute(
        f"""
        ALTER TABLE scheduling.shift_assignments
        ADD CONSTRAINT ck_shift_assignments_assignment_source
        CHECK (assignment_source IN ({", ".join(f"'{v}'" for v in values)}));
        """
    )
