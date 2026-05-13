# Envitron Building GUID Visualizer

Tampermonkey userscript that makes Envitron building GUIDs visible directly on the buildings overview page.

The script adds a small clickable GUID badge next to each building name. Clicking the badge copies the building GUID to your clipboard.

## Features

- Shows building GUIDs on Envitron building cards
- Copies GUIDs to clipboard on click
- Works with dynamically rendered pages
- Supports Envitron domains matching `*.envitron.*`
- Extracts GUIDs directly from building links when available
- Falls back to `/web-api/buildings/` when needed
- Logs useful debug information to the browser console

## Supported URLs

The script runs on Envitron domains such as:

```txt
https://envitron.nl/
https://app.envitron.nl/
https://portal.envitron.energy/
https://something.envitron.com/
