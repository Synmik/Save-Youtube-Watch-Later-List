// Content script to scrape YouTube watch later list
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

async function waitForPageLoad(maxWait = 3000) {
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
    
    await delay(500);
  }
  
  // Final check - if we have any videos, proceed
  const finalCheck = document.querySelectorAll('ytd-playlist-video-renderer');
  if (finalCheck.length === 0) {
    throw new Error('Playlist took too long to load. Please scroll down to load more videos or refresh the page.');
  }
}

async function scrapeVideosWithRetry(maxRetries = 3) {
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
        await delay(1000 * attempt); // Progressive delay
      }
    }
  }
  
  throw new Error(`Scraping failed after ${maxRetries} attempts: ${lastError.message}`);
}

async function scrapeVideos() {
  const videos = [];
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

    // Extract video ID for potential future use
    const linkElement = titleElement || videoElement.querySelector('a[href*="/watch"]');
    const videoId = linkElement ? extractVideoId(linkElement.href) : null;

    return {
      title,
      channel,
      date,
      ...(videoId && { id: videoId }),
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

// Monitor for YouTube navigation changes
let lastUrl = window.location.href;
setInterval(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    console.log('YouTube navigation detected:', lastUrl);
  }
}, 1000);