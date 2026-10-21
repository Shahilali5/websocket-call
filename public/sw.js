// VCall Background Service Worker — Handles Web Push & Background Calling Notifications

const DEFAULT_ICON = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 24 24" fill="%2325d366"><path d="M6.62 10.79a15.053 15.053 0 006.59 6.59l2.2-2.2a1 1 0 011.02-.24c1.12.37 2.33.57 3.57.57a1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1c0 1.25.2 2.45.57 3.57a1 1 0 01-.24 1.02l-2.21 2.2z"/></svg>';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// 1. Web Push Notification handler (wakes up when browser is minimized or closed!)
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch (err) {
    try {
      payload = JSON.parse(event.data.text());
    } catch {
      payload = { type: 'message', text: event.data.text() };
    }
  }

  // If call was cancelled or timed out by caller, close ringing notifications immediately
  if (payload.type === 'call_cancelled') {
    const callTag = `call-${payload.callId}`;
    event.waitUntil(
      self.registration.getNotifications().then((notifications) => {
        notifications.forEach((n) => {
          if (n.tag === callTag || (n.data && n.data.callId === payload.callId)) {
            n.close();
          }
        });
      })
    );
    return;
  }

  // If incoming call alert
  if (payload.type === 'incoming_call') {
    const title = payload.video ? '📹 Incoming Video Call' : '📞 Incoming Voice Call';
    const callerName = payload.callerName || 'Unknown Caller';
    const callerNum = payload.from || '';

    const options = {
      body: `${callerName} (${callerNum}) is calling...`,
      tag: `call-${payload.callId}`,
      icon: (payload.callerAvatar && payload.callerAvatar.startsWith('data:image')) ? payload.callerAvatar : DEFAULT_ICON,
      badge: DEFAULT_ICON,
      renotify: true,
      requireInteraction: true, // Persists until user answers or declines
      vibrate: [400, 200, 400, 200, 400],
      data: {
        callId: payload.callId,
        from: payload.from,
        name: callerName,
        avatar: payload.callerAvatar,
        video: !!payload.video
      },
      actions: [
        { action: 'accept', title: '📞 Accept' },
        { action: 'decline', title: '✕ Decline' }
      ]
    };

    event.waitUntil(self.registration.showNotification(title, options));
    return;
  }

  // Regular message push
  if (payload.type === 'chat_message') {
    const title = `💬 Message from ${payload.from}`;
    const options = {
      body: payload.preview || 'New encrypted message',
      tag: `chat-${payload.from}`,
      icon: DEFAULT_ICON,
      badge: DEFAULT_ICON,
      data: { from: payload.from, url: `/?chat=${payload.from}` }
    };
    event.waitUntil(self.registration.showNotification(title, options));
  }
});

// 2. Notification Click Handler (Accept / Decline actions)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const action = event.action;
  const data = event.notification.data || {};
  const callId = data.callId;

  // Handle Decline button directly without needing full page load
  if (action === 'decline' && callId) {
    event.waitUntil(
      fetch('/api/call/decline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId })
      }).catch((e) => console.warn('[SW] Decline fetch failed:', e))
    );
    return;
  }

  // Handle Accept or Tap on Notification body -> Focus or Open window with ?answer=...
  const targetUrl = callId
    ? `/?answer=${encodeURIComponent(callId)}&from=${encodeURIComponent(data.from || '')}&video=${data.video ? 1 : 0}`
    : (data.url || '/');

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If a window is already open, focus it and navigate
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(targetUrl);
          client.focus();
          return;
        }
      }
      // If no window is open, open a new one
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

// 3. In-tab communication listener
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data) return;

  if (data.type === 'INCOMING_CALL') {
    const title = `📞 Incoming ${data.video ? 'Video' : 'Voice'} Call`;
    self.registration.showNotification(title, {
      body: `${data.callerName || 'Someone'} (${data.from}) is calling you...`,
      icon: DEFAULT_ICON,
      badge: DEFAULT_ICON,
      tag: `call-${data.callId}`,
      renotify: true,
      requireInteraction: true,
      vibrate: [400, 200, 400, 200, 400],
      data: {
        callId: data.callId,
        from: data.from,
        video: data.video
      },
      actions: [
        { action: 'accept', title: '📞 Accept' },
        { action: 'decline', title: '✕ Decline' }
      ]
    });
  } else if (data.type === 'DISMISS_CALL') {
    self.registration.getNotifications().then((notifications) => {
      notifications.forEach((n) => {
        if (n.tag === `call-${data.callId}` || (n.data && n.data.callId === data.callId)) {
          n.close();
        }
      });
    });
  }
});
