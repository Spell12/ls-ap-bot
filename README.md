# LS AP Report Bot v1.3 - SuperNova Fixed

This version is for the SuperNova Linkshell.

Fixes included:
- Dashboard title says SUPERNOVA AP BOARD.
- Victory message says SUPERNOVA.
- Penalty uses CatsEye API by default, so 0% shows correctly.
- FORCE_PENALTY is still optional if you need to manually override.
- Dashboard finder looks for AP BOARD so it edits the same message after restarts/renames.

Required Render variables:
- DISCORD_TOKEN
- CHANNEL_ID
- ANNOUNCEMENT_CHANNEL_ID
- LEADERS_CHANNEL_ID
- LS_ID
- CATSEYE_COOKIE_HEADER
- REFRESH_SECONDS=60
- WEEKLY_CAP=70000
- NEAR_CAP=50000

Optional:
- FORCE_PENALTY=0
  Only add this if you need to force the penalty.
- DASHBOARD_MESSAGE_ID
  Optional. If the bot still creates a duplicate once, copy the correct dashboard message ID and set it here.
