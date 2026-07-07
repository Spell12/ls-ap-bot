# LS AP Report Bot v1.3

Fixes:
- Keeps the correct 25% Farm Week header after Rank #1.
- Keeps the two-column member AP list.
- Removes `left` and `...and X more`.

Optional Render variables:
- `SUMMIT_PHASE_START=2026-07-05` controls the current cycle start date.
- `FORCE_PENALTY=25` can manually override if needed.

Deploy:
Upload files to GitHub, commit, then Render > Manual Deploy > Deploy latest commit.
