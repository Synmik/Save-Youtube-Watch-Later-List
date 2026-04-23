// Content script to scrape YouTube watch later list

// Configuration constants
const CONFIG = {
  MAX_RETRIES: 3,
  PAGE_LOAD_TIMEOUT: 1000,
  PAGE_LOAD_POLL_INTERVAL: 500,
  RETRY_BASE_DELAY: 1000,
  NAVIGATION_CHECK_INTERVAL: 1000,
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== 'scrape') return;

  (async () => {
    try {
      // Validate page context
      validatePageContext();

      // Wait for page to be fully loaded
      await waitForPageLoad();

      // Scrape videos with retry mechanism
      const videos = await scrapeVideosWithRetry();
      console.log(`Successfully scraped ${videos.length} videos`);
      sendResponse({ videos });

    } catch (error) {
      console.error('Scraping error:', error);
      sendResponse({ error: error.message });
    }
  })();

  return true; // Keep message channel open for async response
});

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
    const loadingIndicators = document.querySelectorAll('[role="progressbar"], .skeleton-loader, ytd-continuation-item-renderer');
    
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

async function loadAllPlaylistVideos(maxScrolls = 50, scrollDelay = 400) {
  /**
   * Scrolls through the YouTube playlist to trigger loading of all videos.
   * YouTube uses infinite scrolling — new videos are loaded as you scroll down.
   * This function scrolls to the bottom, waits for content to load, and repeats
   * until no new videos are loaded or maxScrolls is reached.
   *
   * @param {number} maxScrolls - Maximum number of scroll iterations (default 50)
   * @param {number} scrollDelay - Delay in ms between scrolls to allow rendering (default 400)
   * @returns {Promise<void>} Resolves when all videos are loaded
   */
  let previousCount = 0;
  let stagnantIterations = 0;
  const STAGNANT_THRESHOLD = 3; // Stop if no new videos after this many iterations

  for (let i = 0; i < maxScrolls; i++) {
    const currentCount = document.querySelectorAll('ytd-playlist-video-renderer').length;

    // Scroll to the bottom of the playlist
    const scrollContainer = document.querySelector('ytd-playlist-renderer, ytd-playlist-video-list-renderer, #content');
    if (scrollContainer) {
      scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: 'auto' });
    } else {
      window.scrollTo(0, document.body.scrollHeight);
    }

    // Wait for new videos to render
    await delay(scrollDelay);

    const newCount = document.querySelectorAll('ytd-playlist-video-renderer').length;

    if (newCount === previousCount) {
      stagnantIterations++;
      if (stagnantIterations >= STAGNANT_THRESHOLD) {
        console.log(`No new videos loaded after ${stagnantIterations} iterations. All videos loaded.`);
        break;
      }
    } else {
      stagnantIterations = 0;
      console.log(`Loaded ${newCount} videos (was ${previousCount})`);
    }

    previousCount = newCount;
  }

  // Final scroll to top to restore original view
  const scrollContainer = document.querySelector('ytd-playlist-renderer, ytd-playlist-video-list-renderer, #content');
  if (scrollContainer) {
    scrollContainer.scrollTo({ top: 0, behavior: 'auto' });
  } else {
    window.scrollTo(0, 0);
  }

  console.log(`Total videos loaded: ${document.querySelectorAll('ytd-playlist-video-renderer').length}`);
}

async function scrapeVideos() {
  const videos = [];

  // First, ensure all playlist videos are loaded by scrolling through the page
  console.log('Loading all playlist videos by scrolling...');
  await loadAllPlaylistVideos();

  const videoElements = document.querySelectorAll('ytd-playlist-video-renderer');

  if (videoElements.length === 0) {
    throw new Error('No video elements found. The page might still be loading.');
  }

  console.log(`Found ${videoElements.length} video elements`);

  for (let i = 0; i < videoElements.length; i++) {
    try {
      const video = videoElements[i];
      const videoData = extractVideoData(video, i);

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
      '#meta ytd-video-meta-block #metadata span:last-child',
      '#meta #metadata span:last-child',
      '.ytd-video-meta-block span:last-child',
      '[class*="metadata"] span:last-child',
      '#meta span[class*="date"]'
    ];
    
    const dateElement = findElementBySelectors(videoElement, dateSelectors);
    const date = dateElement ? dateElement.textContent.trim() : 'Unknown Date';

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