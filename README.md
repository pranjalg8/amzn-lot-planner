# AMZN lot planner

Static web app that picks which RSU lots to sell for a target amount under India tax rules (24-month long-term test, SBI TT buying rates). It runs entirely in the browser.

- Import the USD open-lots and closed-lots CSV exports from Fidelity. They are stored encrypted in the browser on your own device and are never uploaded.
- Access is gated by a PIN (PBKDF2 hash check in the page). This only deters casual viewing; the repo contains no personal data.
- Estimates only, not tax advice.
