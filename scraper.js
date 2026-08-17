// Content script to scrape YouTube watch later list
//
// Primary path — page-local only (no API calls from the extension, no
// fragile per-video DOM selectors):
//   1. Parse `ytInitialData` from the page HTML (the first batch of videos).
//   2. Intercept the page's OWN continuation responses (the browse requests
//      YouTube itself makes while loading more items) via a fetch/XHR patch
//      injected into the page's main world at document_start. The extension
//      never initiates any network request.
//   3. Scroll the playlist to make the page load every batch (the same
//      infinite-scroll trigger YouTube uses), collecting structured JSON
//      for each video.
// Fallback: classic scroll + DOM extraction if nothing was captured.

const CONFIG = {
  MAX_RETRIES: 3,
  PAGE_LOAD_TIMEOUT: 5000,
  PAGE_LOAD_POLL_INTERVAL: 500,
  RETRY_BASE_DELAY: 1000,
  NAVIGATION_CHECK_INTERVAL: 1000,
  SCROLL_MAX_ITERATIONS: 200,
  SCROLL_DELAY: 600,
  SCROLL_STAGNANT_THRESHOLD: 4, // stop if no new videos after this many scrolls
};

// --- Capture setup (content script runs at document_start — see manifest) ---
injectCaptureScript();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== 'scrape') return;

  (async () => {
    try {
      // Validate page context
      validatePageContext();

      // Preferred: page-local structured data (ytInitialData + the page's
      // own continuation responses)
      let videos = null;
      try {
        videos = await scrapeViaCapturedData();
      } catch (error) {
        console.warn('Page-data scrape failed, falling back to DOM scraping:', error);
      }

      // Fallback: scroll + DOM extraction (ytInitialData missing, consent
      // page, interception blocked, etc.)
      if (!videos || videos.length === 0) {
        await waitForPageLoad();
        videos = await scrapeVideosWithRetry();
      }

      console.log(`Successfully scraped ${videos.length} videos`);
      sendResponse({ videos });

    } catch (error) {
      console.error('Scraping error:', error);
      sendResponse({ error: error.message });
    }
  })();

  return true; // Keep message channel open for async response
});

/* ------------------------------------------------------------------ */
/* Capture: record the page's own continuation responses              */
/* ------------------------------------------------------------------ */

/**
 * Snippet injected into the PAGE'S main world (isolated-world patches
 * wouldn't see the page's fetch/XHR). It patches fetch and XMLHttpRequest
 * and records every playlistVideoRenderer from browse responses into
 * window.__wlsCapture. Runs at document_start, before YouTube's scripts
 * issue their first request.
 */
const CAPTURE_SNIPPET = `
(function () {
  if (window.__wlsCapture) return;

  var store = window.__wlsCapture = { records: {}, order: [] };

  function textOf(t) {
    if (!t) return '';
    if (typeof t === 'string') return t;
    if (t.simpleText) return t.simpleText;
    if (t.runs && t.runs.length !== undefined) {
      var s = '';
      for (var i = 0; i < t.runs.length; i++) s += t.runs[i].text;
      return s;
    }
    return '';
  }

  function looksLikeDate(t) {
    return /^(added |streamed )?((\\d+\\s+\\w+s?\\s+ago)|just now|today|yesterday)/i.test(t);
  }

  function findDate(r) {
    var keys = ['publishedTimeText', 'dateText'];
    for (var i = 0; i < keys.length; i++) {
      var t = textOf(r[keys[i]]);
      if (t && looksLikeDate(t)) return t;
    }
    var found = '';
    (function scan(n) {
      if (found || !n || typeof n !== 'object') return;
      var t = textOf(n);
      if (t && looksLikeDate(t)) { found = t; return; }
      for (var k in n) scan(n[k]);
    })(r);
    return found;
  }

  function add(r) {
    if (!r || !r.videoId || store.records[r.videoId]) return;
    store.records[r.videoId] = {
      videoId: r.videoId,
      title: textOf(r.title),
      channel: textOf(r.ownerText) || textOf(r.longBylineText) || textOf(r.shortBylineText),
      date: findDate(r),
      duration: r.length && r.length.text ? r.length.text : ''
    };
    store.order.push(r.videoId);
  }

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.playlistVideoRenderer) add(node.playlistVideoRenderer);
    for (var k in node) walk(node[k]);
  }

  function isBrowse(u) {
    return typeof u === 'string' && u.indexOf('/youtubei/v1/browse') !== -1;
  }

  // Intercept fetch
  try {
    var origFetch = window.fetch;
    window.fetch = function () {
      var url = arguments[0];
      var u = typeof url === 'string' ? url : (url && url.url) || '';
      var p = origFetch.apply(this, arguments);
      if (isBrowse(u)) {
        p.then(function (res) {
          if (res && res.ok) {
            res.clone().json().then(walk).catch(function () {});
          }
        }).catch(function () {});
      }
      return p;
    };
  } catch (e) {}

  // Intercept XMLHttpRequest
  try {
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__wlsUrl = url;
      this.addEventListener('load', function () {
        if (isBrowse(this.__wlsUrl) && this.responseText) {
          try { walk(JSON.parse(this.responseText)); } catch (e) {}
        }
      });
      return origOpen.apply(this, arguments);
    };
  } catch (e) {}
})();
`;

function injectCaptureScript() {
  try {
    const script = document.createElement('script');
    script.textContent = CAPTURE_SNIPPET;
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  } catch (error) {
    console.warn('Could not inject capture script:', error);
  }
}

/** Read the capture store written by the main-world snippet. */
function getCapturedRecords() {
  const store = document.defaultView.__wlsCapture;
  if (store && store.records && Array.isArray(store.order)) return store;
  return null;
}

/** Map a captured record (from the page's own responses) to our video shape. */
function mapCapturedRecord(r) {
  const dateISO = normalizeDate(r.date);
  return {
    title: r.title || 'Unknown Video',
    channel: r.channel || 'Unknown Channel',
    date: r.date || 'Unknown Date',
    ...(dateISO && { dateISO }),
    ...((() => { const d = normalizeDate(r.date); return d ? { dateISO: d } : {}; })()),
    ...(r.videoId && { id: r.videoId }),
    ...(r.videoId && { thumbnail: `https://i.ytimg.com/vi/${r.videoId}/hqdefault.jpg` }),
    ...(r.duration && { duration: r.duration }),
    scrapedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Primary path: ytInitialData + captured continuation data           */
/* ------------------------------------------------------------------ */

/**
 * Scrape using only data the page itself holds/receives:
 *  - `ytInitialData` in the page HTML (first batch)
 *  - continuation responses captured from the page's own fetches
 * Returns the merged video array, or null when there is nothing to work
 * with (caller should fall back to DOM scraping).
 */
async function scrapeViaCapturedData() {
  const pageHtml = document.documentElement.outerHTML;
  const initialData = extractJsonValue(pageHtml, 'var ytInitialData = ');
  const captured = getCapturedRecords();
  const capturedCount = captured ? captured.order.length : 0;

  // Nothing to anchor on → DOM fallback
  if (!initialData && capturedCount === 0) {
    console.log('No ytInitialData and no captured data available');
    return null;
  }

  // Merge: initial batch first (page order), then captured batches
  const videos = [];
  const seen = new Set();
  const add = (video) => {
    if (!video.id || seen.has(video.id)) return;
    seen.add(video.id);
    videos.push(video);
  };

  const initialBatch = [];
  if (initialData) collectPlaylistVideoRenderers(initialData, initialBatch);
  initialBatch.forEach((r) => add(mapPlaylistVideoRenderer(r)));

  if (captured) {
    captured.order.forEach((id) => add(mapCapturedRecord(captured.records[id])));
  }

  console.log(
    `Page-data scrape starting: ${videos.length} videos from ytInitialData, ` +
    `capture store ${captured ? `has ${captured.order.length} records` : 'NOT PRESENT (inline patch blocked?)'}`
  );

  // Scroll to make the page load remaining batches; the injected patch
  // records each response as it arrives.
  await loadAllPlaylistVideos(() => {
    const cap = getCapturedRecords();
    return initialBatch.length + (cap ? cap.order.length : 0);
  });

  // The rendered DOM is the ground truth for the CURRENT playlist state.
  // ytInitialData and captured responses are frozen at page load, so they
  // keep ghost items that were removed (and miss items that were added)
  // while the page was open. After the scroll loop, every existing video
  // is rendered — so whenever the DOM has rows, prefer it. The JSON-merged
  // list is kept only as a resilience fallback for broken DOM layouts.
  const domCount = document.querySelectorAll('ytd-playlist-video-renderer').length;
  if (domCount > 0) {
    const domVideos = extractVideosFromDom();
    if (domVideos.length > 0) {
      console.log(
        `Scrape complete: ${domVideos.length} videos (DOM master; JSON/capture had ${videos.length})`
      );
      return domVideos;
    }
  }

  console.log(`Scrape complete: ${videos.length} videos (JSON/capture only)`);

  // Zero videos: genuinely empty (DOM fallback will confirm) or a layout
  // we don't recognize.
  return videos.length > 0 ? videos : null;
}

/* ------------------------------------------------------------------ */
/* Page load waiting (DOM fallback path)                              */
/* ------------------------------------------------------------------ */

function validatePageContext() {
  if (!window.location.href.includes('list=WL')) {
    throw new Error('Not on Watch Later page. Please navigate to https://www.youtube.com/playlist?list=WL');
  }

  // Check if YouTube is properly loaded
  if (!document.querySelector('ytd-app')) {
    throw new Error('YouTube app not properly loaded. Please refresh the page.');
  }
}

async function waitForPageLoad(maxWait = CONFIG.PAGE_LOAD_TIMEOUT) {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    // Check if playlist videos are loaded
    const videoElements = document.querySelectorAll('ytd-playlist-video-renderer');
    const loadingIndicators = document.querySelectorAll('[role="progressbar"], .skeleton-loader');

    // If we have videos and no loading indicators, consider it loaded
    if (videoElements.length > 0 && loadingIndicators.length === 0) {
      return;
    }

    // Check for empty playlist message
    const emptyMessage = document.querySelector('[class*="empty"], [class*="no-content"]');
    if (emptyMessage && emptyMessage.textContent.toLowerCase().includes('no videos')) {
      return; // Empty playlist is a valid state
    }

    await delay(CONFIG.PAGE_LOAD_POLL_INTERVAL);
  }

  // Final check - if we have any videos, proceed
  const finalCheck = document.querySelectorAll('ytd-playlist-video-renderer');
  if (finalCheck.length === 0) {
    throw new Error('Playlist took too long to load. Please scroll down to load more videos or refresh the page.');
  }
}

async function scrapeVideosWithRetry(maxRetries = CONFIG.MAX_RETRIES) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Scraping attempt ${attempt}/${maxRetries}`);
      const videos = await scrapeVideos();

      if (videos.length === 0 && attempt < maxRetries) {
        throw new Error('No videos found, retrying...');
      }

      return videos;
    } catch (error) {
      lastError = error;
      console.warn(`Scraping attempt ${attempt} failed:`, error.message);

      if (attempt < maxRetries) {
        await delay(CONFIG.RETRY_BASE_DELAY * attempt); // Progressive delay
      }
    }
  }

  throw new Error(`Scraping failed after ${maxRetries} attempts: ${lastError.message}`);
}

/* ------------------------------------------------------------------ */
/* Scrolling (shared by both paths)                                   */
/* ------------------------------------------------------------------ */

async function loadAllPlaylistVideos(getCount) {
  /**
   * Scrolls through the YouTube playlist to trigger loading of all videos.
   * YouTube uses infinite scrolling via IntersectionObserver on a
   * ytd-continuation-item-renderer element. Scrolling this element into view
   * triggers YouTube to fetch and render the next batch of videos.
   *
   * @param {Function} [getCount] - Optional function returning the current
   *        loaded video count. Defaults to the number of DOM renderers.
   */
  const countOf =
    getCount || (() => document.querySelectorAll('ytd-playlist-video-renderer').length);

  let previousCount = countOf();
  let stagnantIterations = 0;
  const STAGNANT_THRESHOLD = CONFIG.SCROLL_STAGNANT_THRESHOLD;

  for (let i = 0; i < CONFIG.SCROLL_MAX_ITERATIONS; i++) {
    // --- Strategy 1: Scroll the continuation item into view ---
    // YouTube uses ytd-continuation-item-renderer as the trigger for lazy loading.
    // Scrolling it into view reliably triggers YouTube's IntersectionObserver.
    const continuationItem = document.querySelector('ytd-continuation-item-renderer');
    if (continuationItem) {
      continuationItem.scrollIntoView({ behavior: 'auto', block: 'nearest' });
      await delay(CONFIG.SCROLL_DELAY);

    // --- Strategy 2: Scroll the playlist container ---
    } else {
      const scrollContainer = document.querySelector(
        'ytd-playlist-video-list-renderer #contents, ' +
        'ytd-playlist-renderer, ' +
        '#playlist-panel #contents, ' +
        '#primary #contents, ' +
        '#content'
      );
      if (scrollContainer) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      } else {
        window.scrollBy(0, 600);
      }
      await delay(CONFIG.SCROLL_DELAY);
    }

    const newCount = countOf();

    // Report progress to the popup (also acts as a heartbeat so the
    // popup doesn't time out while loading large playlists)
    reportProgress({ phase: 'fetching', count: newCount });

    if (newCount === previousCount) {
      stagnantIterations++;
      console.log(`No new videos (iteration ${i + 1}, stagnant ${stagnantIterations})`);

      if (stagnantIterations >= STAGNANT_THRESHOLD) {
        // One final try: scroll to the very bottom of the page
        console.log('Stagnant threshold reached. Doing one final scroll to bottom...');
        window.scrollTo(0, document.body.scrollHeight);
        await delay(CONFIG.SCROLL_DELAY * 2);

        const finalCount = countOf();
        if (finalCount === newCount) {
          console.log(`No more videos to load. Total: ${finalCount}`);
          break;
        }
        // More loaded — reset and continue
        stagnantIterations = 0;
      }
    } else {
      stagnantIterations = 0;
      console.log(`Loaded ${newCount} videos (was ${previousCount}, +${newCount - previousCount})`);
    }

    previousCount = newCount;
  }

  // Final scroll to top to restore original view
  window.scrollTo(0, 0);
}

/* ------------------------------------------------------------------ */
/* DOM extraction (fallback path)                                     */
/* ------------------------------------------------------------------ */

async function scrapeVideos() {
  // First, ensure all playlist videos are loaded by scrolling through the page
  console.log('Loading all playlist videos by scrolling...');
  await loadAllPlaylistVideos();

  const videoElements = document.querySelectorAll('ytd-playlist-video-renderer');

  if (videoElements.length === 0) {
    throw new Error('No video elements found. The page might still be loading.');
  }

  console.log(`Found ${videoElements.length} video elements`);
  reportProgress({ phase: 'extracting', count: videoElements.length });
  return extractVideosFromDom();
}

function extractVideosFromDom() {
  const videos = [];
  const videoElements = document.querySelectorAll('ytd-playlist-video-renderer');

  for (let i = 0; i < videoElements.length; i++) {
    try {
      const videoData = extractVideoData(videoElements[i], i);

      // Validate required fields
      if (!videoData.title || videoData.title === 'Unknown') {
        console.warn(`Video ${i + 1}: Could not extract title`);
      }

      videos.push(videoData);
    } catch (error) {
      console.warn(`Error processing video ${i + 1}:`, error);
      // Continue with other videos even if one fails
    }
  }

  return videos;
}

function extractVideoData(videoElement, index) {
  try {
    // Extract title with multiple fallback selectors
    const titleSelectors = [
      '#meta h3 a',
      'a#video-title',
      '[id*="title"] a',
      'h3 a',
      '.ytd-playlist-video-renderer a[href*="/watch"]',
      'a[aria-label]'
    ];

    const titleElement = findElementBySelectors(videoElement, titleSelectors);
    const title = titleElement ?
      (titleElement.textContent || titleElement.getAttribute('aria-label') || '').trim() :
      `Unknown Video ${index + 1}`;

    // Extract channel with multiple fallback selectors
    const channelSelectors = [
      '#meta a:nth-of-type(2)',
      '#meta a[href^="/@"]',
      '#meta a[href^="/channel"]',
      '#meta a[href^="/c/"]',
      '#meta [class*="channel"] a',
      '#meta [class*="byline"] a',
      '.ytd-video-owner-renderer a'
    ];

    const channelElement = findElementBySelectors(videoElement, channelSelectors);
    const channel = channelElement ? channelElement.textContent.trim() : 'Unknown Channel';

    // Extract upload date with multiple fallback selectors
    const dateSelectors = [
      '#meta yt-formatted-string#video-info span:last-child',
      '#meta ytd-video-meta-block #metadata span:last-child',
      '#meta #metadata span:last-child',
      '.ytd-video-meta-block span:last-child',
      '[class*="metadata"] span:last-child',
      '#meta span[class*="date"]'
    ];

    const dateElement = findElementBySelectors(videoElement, dateSelectors);
    let date = dateElement ? dateElement.textContent.trim() : 'Unknown Date';
    let dateISO = normalizeDate(date);

    // Fallback: YouTube's accessible name is "<title>, <channel>, <date>[, <duration>]"
    if (date === 'Unknown Date' || !dateISO) {
      const ariaLabel = videoElement.getAttribute('aria-label');
      if (ariaLabel) {
        const parts = ariaLabel.split(',').map((p) => p.trim());
        const candidate = parts[2] || '';
        if (/ago$|today|yesterday|streamed/i.test(candidate)) {
          date = candidate;
          dateISO = normalizeDate(candidate);
        }
      }
    }

    // Extract video ID for thumbnail and URL
    const linkElement = titleElement || videoElement.querySelector('a[href*="/watch"]');
    const videoId = linkElement ? extractVideoId(linkElement.href) : null;

    // Extract thumbnail URL (YouTube provides multiple sizes)
    const thumbnailUrl = videoId ? `https://img.youtube.com/vi/${videoId}/default.jpg` : null;

    // Extract duration from various possible selectors
    const durationSelectors = [
      '#meta .ytd-thumbnail-overlay-time-status-renderer',
      '.ytd-thumbnail-overlay-time-status-renderer #text',
      'ytd-thumbnail-overlay-time-status-renderer span',
      '[class*="time-status"]',
      '.yt-simple-endpoint.style-scope.ytd-playlist-video-renderer + .ytd-thumbnail-overlay-time-status-renderer'
    ];
    const durationElement = findElementBySelectors(videoElement, durationSelectors);
    const duration = durationElement ? durationElement.textContent.trim() : null;

    return {
      title,
      channel,
      date,
      ...(dateISO && { dateISO }),
      ...(videoId && { id: videoId }),
      ...(thumbnailUrl && { thumbnail: thumbnailUrl }),
      ...(duration && { duration }),
      scrapedAt: new Date().toISOString()
    };
  } catch (error) {
    console.error(`Error extracting data from video element:`, error);
    return {
      title: `Unknown Video ${index + 1}`,
      channel: 'Unknown Channel',
      date: 'Unknown Date',
      scrapedAt: new Date().toISOString()
    };
  }
}

function findElementBySelectors(parent, selectors) {
  for (const selector of selectors) {
    try {
      const element = parent.querySelector(selector);
      if (element && element.textContent && element.textContent.trim()) {
        return element;
      }
    } catch (error) {
      console.warn(`Invalid selector: ${selector}`, error);
    }
  }
  return null;
}

function extractVideoId(url) {
  try {
    const urlObj = new URL(url, window.location.origin);
    return urlObj.searchParams.get('v');
  } catch (error) {
    console.warn('Could not extract video ID from URL:', url);
    return null;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Send progress updates to the popup. Failures are harmless: the popup may be
// closed (no listener) or the extension context may be invalidated.
function reportProgress(payload) {
  try {
    const result = chrome.runtime.sendMessage({ action: 'scrapeProgress', ...payload });
    if (result && typeof result.catch === 'function') {
      result.catch(() => {});
    }
  } catch (error) {
    // Ignore — progress reporting must never break scraping
  }
}

/* ------------------------------------------------------------------ */
/* ytInitialData helpers (pure, no DOM)                               */
/* ------------------------------------------------------------------ */

/** Recursively collect all playlistVideoRenderer objects from a JSON tree. */
function collectPlaylistVideoRenderers(node, out) {
  if (!node || typeof node !== 'object') return;
  if (node.playlistVideoRenderer) out.push(node.playlistVideoRenderer);
  for (const key in node) {
    collectPlaylistVideoRenderers(node[key], out);
  }
}

/** True when a text looks like a YouTube relative date ("Added 3 days ago", "just now", ...). */
function looksLikeRelativeDate(t) {
  return /^(added |streamed )?((\d+\s+\w+s?\s+ago)|just now|today|yesterday)/i.test(t);
}

/**
 * Find the display date for a playlistVideoRenderer, robust to layout
 * changes: try known fields first, then scan the renderer subtree for any
 * text that looks like a relative date.
 */
function findRendererDate(renderer) {
  for (const key of ['publishedTimeText', 'dateText']) {
    const t = textOf(renderer[key]);
    if (t && looksLikeRelativeDate(t)) return t;
  }
  let found = '';
  (function scan(node) {
    if (found || !node || typeof node !== 'object') return;
    const t = textOf(node);
    if (t && looksLikeRelativeDate(t)) { found = t; return; }
    for (const k in node) scan(node[k]);
  })(renderer);
  return found;
}

/** Map an InnerTube playlistVideoRenderer to our video shape. */
function mapPlaylistVideoRenderer(r) {
  const id = r.videoId || null;
  const date = findRendererDate(r) || 'Unknown Date';
  const dateISO = normalizeDate(date);
  return {
    title: textOf(r.title) || `Unknown Video`,
    channel: textOf(r.ownerText) || textOf(r.longBylineText) || textOf(r.shortBylineText) || 'Unknown Channel',
    date,
    ...(dateISO && { dateISO }),
    ...(id && { id }),
    ...(id && { thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` }),
    ...(r.length && r.length.text ? { duration: r.length.text } : {}),
    scrapedAt: new Date().toISOString(),
  };
}

/**
 * Convert a YouTube relative date string ("3 days ago") to an ISO timestamp.
 * Stored at scrape time so date filters stay meaningful as the saved list ages.
 * Returns null when the string can't be parsed.
 */
function normalizeDate(dateStr) {
  if (typeof dateStr !== 'string') return null;
  const n = new Date();
  const m = dateStr.match(/(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago/i);
  if (m) {
    const num = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    if (unit === 'minute') return new Date(n.getTime() - num * 60000).toISOString();
    if (unit === 'hour') return new Date(n.getTime() - num * 3600000).toISOString();
    if (unit === 'day') return new Date(n.getTime() - num * 86400000).toISOString();
    if (unit === 'week') return new Date(n.getTime() - num * 604800000).toISOString();
    if (unit === 'month') {
      const d = new Date(n);
      d.setMonth(d.getMonth() - num);
      return d.toISOString();
    }
    if (unit === 'year') {
      const d = new Date(n);
      d.setFullYear(d.getFullYear() - num);
      return d.toISOString();
    }
  }
  const parsed = new Date(dateStr);
  return isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Extract text from an InnerTube contentText ({ simpleText } or { runs }). */
function textOf(contentText) {
  if (!contentText) return '';
  if (typeof contentText === 'string') return contentText;
  if (contentText.simpleText) return contentText.simpleText;
  if (Array.isArray(contentText.runs)) return contentText.runs.map((r) => r.text).join('');
  return '';
}

/**
 * Parse the JSON value (string, object, or array) that follows a marker
 * in the page HTML. Handles nested braces and escaped quotes.
 * Returns the parsed value, or null if the marker is missing / unparseable.
 */
function extractJsonValue(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) return null;

  let i = markerIndex + marker.length;
  const len = source.length;
  while (i < len && /\s/.test(source[i])) i++;
  if (i >= len) return null;

  const start = i;
  const first = source[i];

  // String literal
  if (first === '"') {
    let out = '';
    let escaped = false;
    i++;
    while (i < len) {
      const c = source[i++];
      if (escaped) { out += c; escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') break;
      out += c;
    }
    return out;
  }

  // Object or array — walk to the balanced closing bracket
  if (first === '{' || first === '[') {
    const open = first;
    const close = first === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    while (i < len) {
      const c = source[i++];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) break;
      }
    }
    try {
      return JSON.parse(source.slice(start, i));
    } catch (error) {
      console.warn(`Could not parse JSON after marker "${marker}":`, error.message);
      return null;
    }
  }

  return null;
}

// Add error reporting for better debugging
window.addEventListener('error', (event) => {
  console.error('Page error that might affect scraping:', event.error);
});

// Monitor for YouTube navigation changes using MutationObserver (efficient, event-driven)
// YouTube updates the document title on navigation, so we observe <head> changes
const titleObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.type === 'childList' || mutation.type === 'characterData') {
      console.log('YouTube navigation detected:', window.location.href);
    }
  }
});
titleObserver.observe(document.head || document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true
});

// Also listen for popstate (SPA navigation via back/forward buttons)
window.addEventListener('popstate', () => {
  console.log('YouTube SPA navigation (popstate):', window.location.href);
});
