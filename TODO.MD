TODO (post real-chat phase): feedback loop. Local 👎 with reason buttons
(wrong / missed something in the chat / should've used general knowledge) + export.
Each exported case becomes a bench test. Local only; no data leaves the device.
Per-user and cross-user learning deferred.

TECH DEBT (router, 2026-11-17): the hybrid router misreads shorthand.
- "y do we need workers", "ye workers kyu chahiye", "y that date" -> routed lookup (should be explain)
- "who invented the telephone" -> routed lookup (should be explain)
- "lawyer ka naam kya tha" -> routed explain (should be lookup)
Possible fix later: expand shorthand (y/kyu/wat/pw/u/n) before routing, and add these as router examples.
