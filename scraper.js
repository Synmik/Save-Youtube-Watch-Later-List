// Content script to scrape YouTube watch later list
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== 'scrape') return;

  (async () => {
    try {
      // Check if on watch later page
      if (!window.location.href.includes('list=WL')) {
        sendResponse({
          error: 'Not on Watch Later page. Please navigate to https://www.youtube.com/playlist?list=WL'
        });
        return;
      }

      const videos = [];
      const videoElements = document.querySelectorAll('ytd-playlist-video-renderer');

      for (const video of videoElements) {
        // Extract title
        const titleElement = video.querySelector('#meta h3 a, a#video-title, [id*="title"] a, h3 a');
        const title = titleElement ? titleElement.textContent.trim() : 'Unknown';

        // Extract channel
        const channelElement = video.querySelector('#meta a:nth-of-type(2), #meta a[href^="/@"], #meta a[href^="/channel"], #meta [class*="channel"] a, #meta [class*="byline"] a');
        const channel = channelElement ? channelElement.textContent.trim() : 'Unknown';

        // Extract upload date
        const dateElement = video.querySelector('#meta ytd-video-meta-block #metadata span:last-child');
        const date = dateElement ? dateElement.textContent.trim() : 'Unknown';

        videos.push({
          title,
          channel,
          date
          //thumbnail: thumbnailBlob,
          //id
        });
      }

      sendResponse({ videos });
    } catch (e) {
      sendResponse({ error: 'Scraping failed: ' + e.message });
    }
  })();

  return true;
});