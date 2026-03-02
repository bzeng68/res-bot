// Resy Token Extractor Bookmarklet
// To use: Drag this to your bookmarks bar, then click it while on resy.com

javascript:(function(){
  if (!window.location.hostname.includes('resy.com')) {
    alert('Please run this bookmarklet on resy.com while logged in!');
    return;
  }
  
  const TARGET_URL = 'http://localhost:5173';
  
  // Try to intercept the next fetch/XHR request
  const originalFetch = window.fetch;
  let captured = false;
  
  window.fetch = function(...args) {
    const [url, options] = args;
    if (url.includes('api.resy.com') && options?.headers && !captured) {
      const headers = options.headers instanceof Headers ? 
        Object.fromEntries(options.headers.entries()) : options.headers;
      
      const token = headers['X-Resy-Auth-Token'] || 
                   headers['x-resy-auth-token'] ||
                   headers['Authorization']?.replace('Bearer ', '');
      
      if (token && token.startsWith('ey')) {
        captured = true;
        window.fetch = originalFetch; // Restore
        window.open(`${TARGET_URL}/#token=${encodeURIComponent(token)}`, '_blank');
        return originalFetch.apply(this, args);
      }
    }
    return originalFetch.apply(this, args);
  };
  
  // Trigger an API call by fetching user data
  fetch('https://api.resy.com/3/user', {
    headers: {
      'Authorization': 'ResyAPI api_key="VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5"',
      'X-Resy-Auth-Token': document.cookie.split(';').find(c => c.includes('resy'))?.split('=')[1] || ''
    }
  }).then(() => {
    if (!captured) {
      // Try reading from window object if fetch didn't work
      setTimeout(() => {
        window.fetch = originalFetch;
        if (!captured) {
          alert('Could not find token. Make sure you are logged in to Resy, then try:\n\n1. Search for a restaurant\n2. Click this bookmarklet again\n\nOr manually copy the token from Network tab.');
        }
      }, 1000);
    }
  }).catch(() => {
    window.fetch = originalFetch;
  });
  
  // Show loading message
  const div = document.createElement('div');
  div.style.cssText = 'position:fixed;top:20px;right:20px;background:#3b82f6;color:white;padding:16px 24px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.3);z-index:10000;font-family:sans-serif;font-size:14px;';
  div.textContent = '🔍 Extracting Resy token...';
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 3000);
})();
