# Skyplot

Skyplot is a web application built with [Next.js](https://nextjs.org) for visualizing atmospheric wind data at multiple levels. It provides interactive plots and tools to explore meteorological datasets, making it useful for weather enthusiasts, researchers, and educators.

## Features

- Visualize wind data at various atmospheric levels
- Interactive and responsive UI
- Fast, modern web experience powered by Next.js
- Easily extensible for additional meteorological data

## Getting Started

First, install dependencies:

```bash
npm install
# or
yarn install
# or
pnpm install
# or
bun install
```

Then, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser to see the app.

## Usage

- Edit the main page in `app/page.tsx` to customize the UI or add new features.
- Wind data is located in `public/data/` and can be updated or extended as needed.
- UI components are in `app/components/`.

## Project Structure

- `app/` – Main application code (pages, components, styles)
- `public/` – Static assets and wind data files
- `lib/` – Utility functions
- `README.md` – Project documentation
