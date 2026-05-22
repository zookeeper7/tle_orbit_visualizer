# TLE Visualizer

Satellite communication schedule management system built with CesiumJS, satellite.js, Express, and SQLite.

Multi-satellite 3D/2D orbit visualization, automatic pass-schedule computation across multiple ground stations with per-antenna conflict detection, on-the-fly TLE generation from three sources, and screen recording — all in a single vanilla-JS web app.

![Main view — 3D globe with multi-satellite orbits, ground stations, and pass schedule](images/main_view.png)

## Features

### Visualization & Analysis
- **Orbit Viewer** — Multi-satellite 3D/2D orbit visualization with tapered trail, nadir tracking, ground station coverage, and high-DPI label rendering
- **2D Map Projection** — Switch to a flat Mercator projection at any time; orbit trails project as ground tracks with the same satellite colors and ground-station coverage circles preserved

  ![2D scene mode — ground tracks projected on a flat world map](images/2d_view.png)

- **Track Camera** — Follow a focused satellite with a north-up camera (sub-satellite-point lookAt) while keeping user zoom; auto-pauses in 2D/Columbus modes

  ![Tracking view — camera locked onto ISS with the orbital path visible](images/Tracking_view.png)

- **Reference Time** — Render past/future orbits and Pass Schedule centered on any chosen UTC epoch (live mode = real time)
- **Interactive Keplerian Orbit** — Adjust the 6 classical elements (a, e, i, Ω, ω, ν) via sliders + number inputs directly inside the Orbit Viewer. The orbit re-renders **live while you drag** (throttled to ~20 fps in-memory) and is **persisted to the database when you release** the slider, so the demonstration is responsive without thrashing the API. Reset restores ISS-like defaults; Remove deletes the satellite via the API
- **Schedule Manager** — Batch pass computation for any satellite group flagged as "schedulable" across multiple ground stations with per-antenna conflict detection
- **Timeline** — Interactive Gantt chart with zoom, scroll, conflict overlays, and bulk pass selection

### TLE Sources & Generators
- **CelesTrak / NORAD Fetch** — One-shot or batch fetch for any satellite with a NORAD ID, with optional **Auto Refresh** at 30 min / 1 h / 2 h / 6 h intervals (refreshes orbit + Pass Schedule automatically)
- **TLE from Separation Vector** — Convert a launch separation state (WGS84 ECEF position + Earth-relative velocity at UTC) into an SGP4-compatible TLE
- **TLE from Classical Orbital Elements** — Generate a TLE from the 6 Keplerian elements at a UTC epoch, with osculating → mean conversion verified by SGP4 round-trip
- **Manual TLE** — Paste any 3-line TLE for satellites not in CelesTrak

### Recording
- **Tab-Capture Recording** — Records the entire visible page (3D scene + side panels + playback bar) into a single WebM video file via `getDisplayMedia` + `MediaRecorder` at 24 / 30 / 60 fps. Captures smoothly at any playback speed up to 360×.

### Configuration
- **Satellites** — CRUD with optional CelesTrak name/NORAD search, color picker, enable toggle, group classification
- **Ground Stations** — CRUD with lat/lon/min-elevation
- **Azimuth Mask** — Per-antenna terrain/building obstruction profiles (CSV import) with pass sub-splitting
- **Antenna Management** — Hierarchical station → antenna → satellite mapping with free-text antenna types and primary/backup role assignment
- **Persistent Storage** — Express + SQLite backend; all data survives browser refresh

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vite 8 + CesiumJS 1.139 + satellite.js 6.0 |
| Backend | Node.js + Express 5 + better-sqlite3 |
| Database | SQLite (file: `data/schedule.db`) |
| UI Theme | Custom glassmorphism (no framework) |

## Quick Start

```bash
# Install dependencies
npm install

# Start backend (port 3001)
npm run server

# Start frontend dev server (port 5173, proxies /api → 3001)
npm run dev
```

Open http://localhost:5173. Both servers must be running.

## Production Build

```bash
npm run build    # outputs to dist/
npm run server   # serve API
# Serve dist/ with any static file server, proxy /api to :3001
```

## Project Structure

```
server.js                    # Express + SQLite REST API
data/schedule.db             # SQLite database (auto-created)

src/
  main.js                    # App shell: shared Cesium viewer (native DPR, preserveDrawingBuffer) + tab init
  
  core/
    app-store.js             # Centralized state (getState/patch/subscribe)
    api.js                   # Frontend REST client (satellites/stations/antennas/mappings/passes/settings)
    azimuth-mask.js          # CSV parser + piecewise-linear interpolation
    conflict-detection.js    # Sorted-sweep per-antenna overlap detection
    
  tabs/
    orbit-viewer.js          # Orbit Viewer tab — multi-sat overlay, Reference Time, Track, Recording, Interactive Keplerian
    schedule-manager.js      # Multi-satellite pass scheduling tab
    timeline-view.js         # Gantt timeline tab embedded in Schedule Manager
    configuration.js         # Satellites / Stations / Antennas & Masks / Antenna Mappings CRUD
    
  ui/
    tab-bar.js               # Tab navigation
    
  visualization.js           # CesiumJS entity rendering (tapered orbits, high-DPR labels)
  orbit.js                   # TLE parsing + SGP4 propagation (accepts referenceDate for any-epoch propagation)
  pass-prediction.js         # Pass computation with mask support
  separation-vector.js       # ECEF state vector & 6 classical Keplerian elements → SGP4 TLE
  ground-stations.js         # Default station definitions
  presets.js                 # Satellite preset TLE data
  tle-fetch.js               # CelesTrak GP API connectivity (fetch + name/NORAD search)
  style.css                  # Glassmorphism theme

public/
  ground-stations.json       # Default station + antenna seed data
```

## REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/satellites` | List satellites (id, name, NORAD, color, group, enabled, TLE) |
| POST | `/api/satellites` | Create satellite |
| PUT | `/api/satellites/:id` | Update satellite (TLE, color, enabled, …) |
| DELETE | `/api/satellites/:id` | Delete satellite |
| GET | `/api/stations` | List stations with antennas |
| POST | `/api/stations` | Create station |
| DELETE | `/api/stations/:id` | Delete station (cascades) |
| GET | `/api/antennas` | List antennas |
| POST | `/api/antennas` | Create antenna |
| DELETE | `/api/antennas/:id` | Delete antenna (cascades) |
| GET | `/api/antenna-mappings` | List satellite-antenna mappings |
| POST | `/api/antenna-mappings` | Create mapping |
| PATCH | `/api/antenna-mappings/:id` | Update mapping role (primary/backup) |
| DELETE | `/api/antenna-mappings/:id` | Remove mapping |
| GET | `/api/antennas/:id/mask` | Get azimuth mask |
| POST | `/api/antennas/:id/mask/csv` | Upload mask CSV |
| PUT | `/api/antennas/:id/mask` | Replace mask entries |
| DELETE | `/api/antennas/:id/mask` | Clear mask |
| GET | `/api/passes` | List passes (filterable) |
| POST | `/api/passes/bulk` | Bulk upsert passes |
| PATCH | `/api/passes/:id` | Update pass status/details |
| GET | `/api/settings/:key` | Read a user setting (e.g. saved satellite selection) |
| PUT | `/api/settings/:key` | Write a user setting |

## Preset Satellites

A minimal seed set is provided so the app is demoable on first run. Both groups are flagged `schedulable=true` by default, so the 11 satellites appear in the Orbit Viewer overlay selector and the Schedule Manager. The TLEs are synthetic placeholders — use Configuration → Add Satellite → Search CelesTrak (or Fetch Latest TLE) to switch to real elements.

| Group | Color | Satellites |
|-------|-------|-----------|
| General  | slate    | ISS (ZARYA), Hubble Space Telescope, NOAA 19, CSS (TIANHE) |
| Sentinel | emerald  | Sentinel-1A, Sentinel-2A, Sentinel-2B, Sentinel-3A, Sentinel-3B, Sentinel-5P, Sentinel-6 Michael Freilich |

> Add your own groups under Configuration → Groups. Each group has its own color, sort order, and `schedulable` flag.

## Default Ground Stations

| Station | Location | Antennas |
|---------|----------|----------|
| Demo Station Alpha | 25.3N, 51.5E   (Doha)    | 2 |
| Demo Station Beta  | 60.0N, 10.0E   (Norway)  | 2 |
| Demo Station Gamma | 33.9S, 151.2E  (Sydney)  | 1 |

## What's Included in This Release

**Visualization**
- 3D globe + 2D Mercator scene modes with per-mode quality profile (DPR / MSAA / atmosphere) — switches instantly without losing playback state
- Tapered multi-band orbit trail (6 bands per side, thinning from the satellite position) with memoized callback so trail updates don't trigger per-frame ground-polyline re-tessellation
- Sub-satellite-point camera tracking with a three-state Track button (idle / following / following-different-target)
- Reference Time control — visualize any UTC epoch, not just live
- Tab-capture screen recording into WebM at 24 / 30 / 60 fps, captures the whole page including side panels

**TLE management**
- CelesTrak GP API integration: search by name or NORAD ID, batch refresh, optional auto-refresh on 30 min / 1 h / 2 h / 6 h cadence
- Three offline TLE generators: launch separation vector, classical orbital elements, and an interactive sliders panel that re-renders live and commits on drag-release
- Free-form group taxonomy with per-group color, sort order, and a `schedulable` flag that drives whether the group's satellites appear in Schedule Manager / Orbit Viewer

**Schedule Manager**
- Batch pass computation across all schedulable satellites and all ground stations
- Per-antenna conflict detection (sorted-sweep), CSV export
- Embedded Gantt timeline with zoom / scroll / status filters and a per-status opacity gradient

**Configuration**
- Five CRUD sub-sections: Satellites, Groups, Stations, Antennas & Masks, Antenna Mappings
- Per-antenna azimuth mask import (CSV) with piecewise-linear interpolation and pass sub-splitting
- All data persisted server-side in SQLite; defaults are seeded automatically on first boot and idempotent on subsequent boots

**Performance**
- Native-DPR rendering in 3D, CSS-pixel rendering in 2D, MSAA off in 2D, lighting / atmosphere / fog auto-disabled in 2D
- `requestRenderMode` on with `maximumRenderTimeChange: 0` so paused playback drops to zero GPU
- Orbit-trail callback short-circuits on hidden-mode bands and memoizes by slice index with a 100 ms wall-time throttle ceiling

## License

Licensed under the Apache License, Version 2.0 — see [LICENSE](LICENSE) for the full text.

Copyright 2026 Jaeung Han.

This project depends on CesiumJS (Apache 2.0), satellite.js (MIT), Express (MIT), better-sqlite3 (MIT), and Vite (MIT); all are compatible with Apache 2.0 redistribution.
