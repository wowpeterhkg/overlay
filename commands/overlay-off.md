---
description: Stop the overlay tag-fixing loop (and the bridge if this session started it)
---

Stop the overlay workflow:

1. Stop polling — end the work loop now.
2. If THIS session spawned the bridge process (background Bash task), kill that task. If the bridge was already running when /overlay-on probed it (reused), leave it alone — another session may own it.
3. Tell the user: loop stopped; the extension keeps working standalone (tags queue locally; chip shows `⇅ off` once the bridge is gone) and /overlay-on restarts the workflow anytime.
