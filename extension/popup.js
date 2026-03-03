// Popup script - shows extension status

async function updateStatus() {
  try {
    // Send message to background script to check connection
    const response = await chrome.runtime.sendMessage({ type: 'CHECK_STATUS' });
    
    const statusDiv = document.getElementById('status');
    
    if (response && response.connected) {
      statusDiv.className = 'status connected';
      statusDiv.textContent = '✅ Connected to backend';
    } else {
      statusDiv.className = 'status disconnected';
      statusDiv.textContent = '❌ Disconnected from backend';
    }
  } catch (error) {
    console.error('Failed to check status:', error);
    const statusDiv = document.getElementById('status');
    statusDiv.className = 'status disconnected';
    statusDiv.textContent = '❌ Extension error';
  }
}

// Update status when popup opens
updateStatus();

// Refresh status every 2 seconds
setInterval(updateStatus, 2000);
