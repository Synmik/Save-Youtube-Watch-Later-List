# YouTube Watch Later List

A Chrome extension to scrape, save, and manage your YouTube Watch Later playlist.

<img width="599" height="564" alt="Image" src="https://github.com/user-attachments/assets/c1a0c627-b7c8-40ce-8fd8-a2a6db1e866e" />

## Features
- **Scrape & Save** — Extracts video title, channel, upload date, thumbnail, and duration
- **Auto-scroll** — Automatically scrolls through the playlist to load all videos before scraping
- **Search** — Filter videos by title or channel name (with debounced input)
- **Sort and Filter** — Sort by default order, title, channel, newest, or oldest. Filter by all videos, last week, last month, or last year
- **Dark/Light Theme** — Toggle between light and dark mode; preference is saved locally
- **Import/Export** — Download your saved list as a JSON file/Load a previously exported JSON
- **No YouTube API** — No authentication or API keys required
- **Local Storage** — All data is stored locally in Chrome storage

## Installation
1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked" and select the folder containing these files
5. The extension icon should appear in your toolbar

## Usage
1. Navigate to your YouTube Watch Later page: https://www.youtube.com/playlist?list=WL
2. Click the extension icon in the toolbar
3. Click the **Save Videos** button to scrape your playlist
4. The popup will show scraping progress and confirmation
5. Subsequent saves will overwrite the previous list

## Icon Image Attribution
<a href="https://www.flaticon.com/free-icons/playlist" title="playlist icons">Playlist icons created by Xinh Studio - Flaticon</a>