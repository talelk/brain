---
type: Template
title: "App screens template: one entry per web app"
---

Copy this entry once for each web app, name the copy `app-screens-<app>.md`, and replace everything in angle brackets. The walkthrough agents find these entries with `memory.search` (they search for "app screens" and the app's name). Until an app has its entry, a weekly sweep cannot tell what to visit.

## App

- Name: `<app name, as people say it>`
- Address: `<https://... of the app to test>`; the host must be reachable from the sandbox, so list it under `network` for the project
- Languages: `<English, French, Arabic>`
- Test account: `<user name, and the name of the secret that holds the password; never a real person's account>`

## Screens, in the order a new visitor meets them

1. `<screen name>`: `<how to reach it from the first screen>`; main action: `<what a user does here once>`
2. `<screen name>`: `<how to reach it>`; main action: `<...>`

Brain's engine image carries a browser (Playwright and Chromium, launched with `--no-sandbox`). The app's address must be in the project's `network`.
