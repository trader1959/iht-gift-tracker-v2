# IHT Gift Tracker v2.0.1

Local Node.js app for UK Inheritance Tax gift planning.

## Quick Start
1. Install Node.js from https://nodejs.org/
2. Double-click start-app.bat
3. App opens at http://localhost:3050

## Manual Start
  npm install
  npm start        (production)
  npm run dev      (auto-restart on changes)

## Project Structure
  server.js              Express API (29 endpoints)
  package.json           Dependencies
  start-app.bat          Windows launcher
  public/index.html      Frontend UI
  public/app-inline.js   Frontend JavaScript
  data/db.json           Gift records & settings (auto-created)
  data/proofs/           Uploaded proof PDFs (auto-created)

## Fixes Applied in v2.0.1
  - Safe atomic writeDb() with .tmp rename - prevents data corruption on crash
  - sevenYearGifts initialised in readDb() - fixes crash on older data files
  - Proof PDFs deleted from disk when parent gift is deleted
  - Inline require() calls replaced with top-level module imports
  - start-app.bat port corrected from 3000 to 3050
  - nodemon added as devDependency (npm run dev)
