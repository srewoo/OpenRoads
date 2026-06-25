// Open Roads — MV3 service worker.
// Clicking the toolbar icon opens the game in its own full-page tab.
// Uses NO permissions: chrome.tabs.create and chrome.runtime are available by default.

const GAME_URL = chrome.runtime.getURL('game.html');

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: GAME_URL });
});

// Open the game once on install so the player finds it immediately.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: GAME_URL });
  }
});
