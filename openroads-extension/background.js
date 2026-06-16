// Open Roads — MV3 service worker.
// Clicking the toolbar icon opens the game in its own full-page tab.
// If a game tab is already open, focus it instead of spawning duplicates.

const GAME_URL = chrome.runtime.getURL('game.html');

chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: GAME_URL });
  if (tabs.length > 0) {
    const tab = tabs[0];
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: GAME_URL });
  }
});

// Open the game once on install so the player finds it immediately.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: GAME_URL });
  }
});
