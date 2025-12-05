// Popup script
document.addEventListener('DOMContentLoaded', () => {
  const saveBtn = document.getElementById('saveBtn');
  const exportBtn = document.getElementById('exportBtn');
  const clearBtn = document.getElementById('clearBtn');
  const status = document.getElementById('status');
  const videoCount = document.getElementById('videoCount');
  const searchInput = document.getElementById('searchInput');
  const sortSelect = document.getElementById('sortSelect');
  const filterSelect = document.getElementById('filterSelect');
  const themeToggle = document.getElementById('themeToggle');

  let allVideos = [];
  let filteredVideos = [];

  // Load and display saved list on popup open
  loadSavedVideos();
  loadTheme();

  // Event listeners
  saveBtn.addEventListener('click', handleSaveClick);
  exportBtn.addEventListener('click', handleExportClick);
  clearBtn.addEventListener('click', handleClearClick);
  searchInput.addEventListener('input', applyFiltersAndSort);
  sortSelect.addEventListener('change', applyFiltersAndSort);
  filterSelect.addEventListener('change', applyFiltersAndSort);
  themeToggle.addEventListener('click', toggleTheme);

  async function loadSavedVideos() {
    try {
      const result = await chrome.storage.local.get(['watchLater']);
      allVideos = result.watchLater || [];
      updateVideoCount();
      applyFiltersAndSort();
    } catch (error) {
      console.error('Error loading saved videos:', error);
      showStatus('Error loading saved videos', 'error');
    }
  }

  async function loadTheme() {
    try {
      const result = await chrome.storage.local.get(['theme']);
      const theme = result.theme || 'light';
      console.log('DEBUG: Loading theme from storage:', theme);
      if (theme === 'dark') {
        applyDarkMode();
      } else {
        applyLightMode();
      }
      updateThemeIcon(theme);
      updateThemeAriaPressed(theme);
      applyFiltersAndSort();
    } catch (error) {
      console.error('Error loading theme:', error);
    }
  }

  function toggleTheme() {
    const currentTheme = document.body.classList.contains('dark-mode') ? 'dark' : 'light';
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    
    if (newTheme === 'dark') {
      applyDarkMode();
    } else {
      applyLightMode();
    }
    
    updateThemeIcon(newTheme);
    updateThemeAriaPressed(newTheme);
    
    // Save theme preference
    chrome.storage.local.set({ 'theme': newTheme });
    
    applyFiltersAndSort();
  }

  function updateThemeAriaPressed(theme) {
    const toggleButton = document.getElementById('themeToggle');
    if (toggleButton) {
      toggleButton.setAttribute('aria-pressed', theme === 'dark');
    }
  }

  function applyDarkMode() {
    document.body.classList.add('dark-mode');
    document.querySelector('.header').classList.add('dark-mode');
    document.querySelector('.filters').classList.add('dark-mode');
    document.querySelectorAll('.form-control').forEach(input => input.classList.add('dark-mode'));
    document.querySelector('.content').classList.add('dark-mode');
  }

  function applyLightMode() {
    document.body.classList.remove('dark-mode');
    document.querySelector('.header').classList.remove('dark-mode');
    document.querySelector('.filters').classList.remove('dark-mode');
    document.querySelectorAll('.form-control').forEach(input => input.classList.remove('dark-mode'));
    document.querySelector('.content').classList.remove('dark-mode');
  }

  function updateThemeIcon(theme) {
    const icon = themeToggle.querySelector('.theme-icon');
    if (icon) {
      icon.textContent = theme === 'dark' ? '☀️' : '🌙';
    }
  }

  async function handleSaveClick() {
    const maxRetries = 3;
    let attempt = 0;
    
    while (attempt < maxRetries) {
      try {
        attempt++;
        showStatus(`Scraping watch later list... (Attempt ${attempt}/${maxRetries})`, 'loading');
        saveBtn.disabled = true;

        // Get active tab with timeout
        const tab = await getActiveTabWithTimeout(5000);
        validateTab(tab);

        // Send message to content script with timeout
        const response = await sendMessageToTabWithTimeout(tab.id, { action: 'scrape' }, 10000);
        validateScrapingResponse(response);

        const { videos } = response;
        if (videos.length === 0) {
          showStatus('No videos found in watch later list. The page might still be loading.', 'warning');
          if (attempt < maxRetries) {
            await delay(2000);
            continue;
          }
          return;
        }

        // Save to local storage
        await chrome.storage.local.set({ 'watchLater': videos });
        allVideos = videos;
        updateVideoCount();
        applyFiltersAndSort();
        showStatus(`Successfully saved ${videos.length} videos!`, 'success');
        return;

      } catch (error) {
        console.error(`Attempt ${attempt} failed:`, error);
        
        if (attempt === maxRetries) {
          showStatus(`Failed after ${maxRetries} attempts: ${error.message}`, 'error');
        } else {
          showStatus(`Attempt ${attempt} failed, retrying... (${error.message})`, 'warning');
          await delay(1000);
        }
      }
    }
    
    saveBtn.disabled = false;
  }

  function validateTab(tab) {
    if (!tab) {
      throw new Error('No active tab found');
    }
    if (!tab.url) {
      throw new Error('Cannot access tab URL. Please refresh the page.');
    }
    if (!tab.url.includes('youtube.com')) {
      throw new Error('Please navigate to YouTube');
    }
    if (!tab.url.includes('list=WL')) {
      throw new Error('Please navigate to your Watch Later page: https://www.youtube.com/playlist?list=WL');
    }
  }

  function validateScrapingResponse(response) {
    if (!response) {
      throw new Error('No response from page. Please refresh and try again.');
    }
    if (response.error) {
      throw new Error(response.error);
    }
    if (!response.videos || !Array.isArray(response.videos)) {
      throw new Error('Invalid response format from scraper');
    }
  }

  function getActiveTabWithTimeout(timeout = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timeout getting active tab'));
      }, timeout);

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(tabs[0]);
        }
      });
    });
  }

  function sendMessageToTabWithTimeout(tabId, message, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timeout: Page took too long to respond. Try refreshing the page.'));
      }, timeout);

      chrome.tabs.sendMessage(tabId, message, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  status.style.display = 'none';
  
  function showStatus(message, type = 'info') {
    console.log('DEBUG: showStatus called with message:', message, 'type:', type);
    status.textContent = message;
    status.className = `status-${type}`;
    
    // Show the status div when there's content
    if (message) {
      status.style.display = 'block';
    }
    
    if (type === 'success' || type === 'error') {
      setTimeout(() => {
        console.log('DEBUG: Clearing status message after timeout');
        if (status.textContent === message) {
          status.textContent = '';
          status.className = '';
          status.style.display = 'none';
        }
      }, 5000);
    }
  }

  function updateVideoCount() {
    const count = allVideos.length;
    videoCount.textContent = count > 0 ? `${count} videos saved` : 'No videos saved';
  }

  function applyFiltersAndSort() {
    let videos = [...allVideos];
    
    // Apply search filter
    const searchTerm = searchInput.value.toLowerCase().trim();
    if (searchTerm) {
      videos = videos.filter(video => 
        video.title.toLowerCase().includes(searchTerm) ||
        video.channel.toLowerCase().includes(searchTerm)
      );
    }

    // Apply date filter
    const filterValue = filterSelect.value;
    if (filterValue !== 'all') {
      const now = new Date();
      const cutoffDate = new Date();
      
      switch (filterValue) {
        case 'week':
          cutoffDate.setDate(now.getDate() - 7);
          break;
        case 'month':
          cutoffDate.setMonth(now.getMonth() - 1);
          break;
        case 'year':
          cutoffDate.setFullYear(now.getFullYear() - 1);
          break;
      }
      
      videos = videos.filter(video => {
        const videoDate = parseVideoDate(video.date);
        return videoDate >= cutoffDate;
      });
    }

    // Apply sorting
    const sortValue = sortSelect.value;
    switch (sortValue) {
      case 'title':
        videos.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case 'channel':
        videos.sort((a, b) => a.channel.localeCompare(b.channel));
        break;
      case 'date-new':
        videos.sort((a, b) => parseVideoDate(b.date) - parseVideoDate(a.date));
        break;
      case 'date-old':
        videos.sort((a, b) => parseVideoDate(a.date) - parseVideoDate(b.date));
        break;
    }

    filteredVideos = videos;
    displayList(filteredVideos);
  }

  function parseVideoDate(dateStr) {
    // Handle various YouTube date formats
    const now = new Date();
    if (dateStr.includes('ago')) {
      if (dateStr.includes('minute')) {
        const minutes = parseInt(dateStr.match(/\d+/)?.[0] || '0');
        return new Date(now.getTime() - minutes * 60000);
      } else if (dateStr.includes('hour')) {
        const hours = parseInt(dateStr.match(/\d+/)?.[0] || '0');
        return new Date(now.getTime() - hours * 3600000);
      } else if (dateStr.includes('day')) {
        const days = parseInt(dateStr.match(/\d+/)?.[0] || '0');
        return new Date(now.getTime() - days * 86400000);
      } else if (dateStr.includes('week')) {
        const weeks = parseInt(dateStr.match(/\d+/)?.[0] || '0');
        return new Date(now.getTime() - weeks * 604800000);
      } else if (dateStr.includes('month')) {
        const months = parseInt(dateStr.match(/\d+/)?.[0] || '0');
        const date = new Date(now);
        date.setMonth(date.getMonth() - months);
        return date;
      } else if (dateStr.includes('year')) {
        const years = parseInt(dateStr.match(/\d+/)?.[0] || '0');
        const date = new Date(now);
        date.setFullYear(date.getFullYear() - years);
        return date;
      }
    }
    
    // Try to parse as regular date
    const parsed = new Date(dateStr);
    return isNaN(parsed.getTime()) ? new Date(0) : parsed;
  }

  async function handleExportClick() {
    try {
      if (allVideos.length === 0) {
        showStatus('No videos to export', 'warning');
        return;
      }

      const exportData = {
        exportDate: new Date().toISOString(),
        totalVideos: allVideos.length,
        videos: allVideos
      };

      const dataStr = JSON.stringify(exportData, null, 2);
      const dataBlob = new Blob([dataStr], { type: 'application/json' });
      
      const url = URL.createObjectURL(dataBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `youtube-watch-later-${new Date().toISOString().split('T')[0]}.json`;
      
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      
      showStatus(`Exported ${allVideos.length} videos successfully!`, 'success');
    } catch (error) {
      console.error('Export error:', error);
      showStatus('Export failed: ' + error.message, 'error');
    }
  }

  async function handleClearClick() {
    if (allVideos.length === 0) {
      showStatus('No videos to clear', 'warning');
      return;
    }

    if (confirm(`Are you sure you want to clear all ${allVideos.length} saved videos? This action cannot be undone.`)) {
      try {
        await chrome.storage.local.remove('watchLater');
        allVideos = [];
        updateVideoCount();
        applyFiltersAndSort();
        showStatus('All videos cleared successfully', 'success');
      } catch (error) {
        console.error('Clear error:', error);
        showStatus('Failed to clear videos: ' + error.message, 'error');
      }
    }
  }

  // Display the saved video list in the popup
  function displayList(videos) {
    const list = document.getElementById('savedList');
    list.innerHTML = '';

    if (videos.length === 0) {
      const noItems = document.createElement('li');
      noItems.className = 'no-videos';
      noItems.textContent = searchInput.value ? 'No videos match your search' : 'No videos saved';
      list.appendChild(noItems);
      return;
    }

    const isDarkMode = document.body.classList.contains('dark-mode') ||
                      (document.body.style.backgroundColor === 'rgb(26, 26, 26)' ||
                       document.body.style.backgroundColor === '#1a1a1a');

    videos.forEach((video, index) => {
      const li = document.createElement('li');
      li.className = 'video-item';
      if (isDarkMode) {
        li.classList.add('dark-mode');
      }

      // Apply red styling for modified or deleted videos
      if (video.status === 'modified' || video.status === 'deleted') {
        li.classList.add('modified');
      }

      const titleEl = document.createElement('div');
      titleEl.className = 'video-title';
      titleEl.textContent = video.title;
      if (isDarkMode) {
        titleEl.classList.add('dark-mode');
      }
      li.appendChild(titleEl);

      const metaEl = document.createElement('div');
      metaEl.className = 'video-meta';
      if (isDarkMode) {
        metaEl.classList.add('dark-mode');
      }
      
      const channelEl = document.createElement('span');
      channelEl.className = 'video-channel';
      channelEl.textContent = video.channel;
      if (isDarkMode) {
        channelEl.classList.add('dark-mode');
      }
      metaEl.appendChild(channelEl);

      const dateEl = document.createElement('span');
      dateEl.className = 'video-date';
      dateEl.textContent = video.date;
      if (isDarkMode) {
        dateEl.classList.add('dark-mode');
      }
      metaEl.appendChild(dateEl);

      li.appendChild(metaEl);
      list.appendChild(li);
    });
  }
});
