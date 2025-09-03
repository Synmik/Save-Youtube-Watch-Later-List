// Popup script
document.addEventListener('DOMContentLoaded', () => {
  const saveBtn = document.getElementById('saveBtn');
  const status = document.getElementById('status');

  // Load and display saved list on popup open
  chrome.storage.local.get(['watchLater'], (result) => {
    const savedVideos = result.watchLater || [];
    displayList(savedVideos);
  });

  saveBtn.addEventListener('click', async () => {
    status.textContent = 'Scraping watch later list...';
    saveBtn.disabled = true;

    try {
      // Get active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url.includes('youtube.com')) {
        status.textContent = 'Please navigate to YouTube and open a playlist page.';
        saveBtn.disabled = false;
        return;
      }

      // Check for exact watch later URL
      if (!tab.url.includes('list=WL')) {
        status.textContent = 'Please navigate to your Watch Later page: https://www.youtube.com/playlist?list=WL';
        saveBtn.disabled = false;
        return;
      }

      // Send message to content script
      const response = await sendMessageToTab(tab.id, { action: 'scrape' });

      if (response.error) {
        status.textContent = response.error;
        saveBtn.disabled = false;
        return;
      }

      const { videos } = response;
      if (!Array.isArray(videos)) {
        status.textContent = 'Error: Invalid response from scraper.';
        saveBtn.disabled = false;
        return;
      }
      if (!videos || videos.length === 0) {
        status.textContent = 'No videos found in watch later list.';
        saveBtn.disabled = false;
        return;
      }

      // Save to local storage (overwrites previous)
      await chrome.storage.local.set({ 'watchLater': videos });
      status.textContent = `Saved ${videos.length} videos to local storage. Click again to overwrite.`;
      displayList(videos);
    } catch (error) {
      console.error('Error:', error);
      status.textContent = 'Error: ' + error.message;
    } finally {
      saveBtn.disabled = false;
    }
  });
});


function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}


// Function to display the saved video list in the popup
function displayList(videos) {
  const list = document.getElementById('savedList');
  list.innerHTML = '';

  videos.forEach(video => {
    const li = document.createElement('li');
    li.style.marginBottom = '10px';
    li.style.borderBottom = '1px solid #ddd';
    li.style.paddingBottom = '5px';

    // Title text
    const strong = document.createElement('strong');
    strong.textContent = video.title;
    li.appendChild(strong);

    li.appendChild(document.createElement('br'));

    // Channel
    const channelText = document.createElement('span');
    channelText.textContent = 'Channel: ' + video.channel;
    li.appendChild(channelText);
    li.appendChild(document.createElement('br'));

    // Uploaded date
    const dateText = document.createElement('span');
    dateText.textContent = 'Uploaded: ' + video.date;
    li.appendChild(dateText);

    list.appendChild(li);
  });

  if (videos.length === 0) {
    const noItems = document.createElement('li');
    noItems.textContent = 'No videos saved';
    list.appendChild(noItems);
  }
}