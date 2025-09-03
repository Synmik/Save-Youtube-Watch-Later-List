# Save Youtube Watch Later List

A Chrome extension to scrape and save your YouTube watch later playlist entries.

## Features
- Saves video title, channel, upload date
- Overwrites previous saves on each click
- No YouTube API or authentication required
- Stores data locally in Chrome storage

## Installation
1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked" and select the folder containing these files
5. The extension icon should appear in your toolbar

## Usage
1. Navigate to your YouTube watch later page: https://www.youtube.com/playlist?list=WL
2. Click the extension icon in the toolbar
3. Click "Save Watch Later List" button
4. The popup will show scraping progress and confirmation
5. Data is saved to local storage; clicking again will overwrite

- Access saved data in Chrome DevTools: Go to Application > Storage > Local Storage > chrome-extension://YOUR_ID > key 'watchLater'

## Icon image attribution
<a href="https://www.flaticon.com/free-icons/playlist" title="playlist icons">Playlist icons created by Xinh Studio - Flaticon</a>