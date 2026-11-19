self.addEventListener('push', event => {
  event.waitUntil(self.registration.showNotification('Orche 排期未完成', {
    body: '打开 BonLog 查看状态。',
    icon: '/icons/bonlife-192.png',
    tag: 'bonlog-orche',
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(new URL('?orche=1', self.registration.scope).href));
});
