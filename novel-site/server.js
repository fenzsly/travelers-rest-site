const path = require('node:path');
const express = require('express');
const { baseApp, errorHandlers, UPLOAD_DIR } = require('./src/common');
const { router: publicRouter } = require('./src/routes/public');
const { createAdminApp } = require('./src/admin');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PORT = Number(process.env.ADMIN_PORT) || 0;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

const app = baseApp(path.join(__dirname, 'views'));
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));
app.use((req, res, next) => {
  res.locals.adminUrl = ADMIN_PORT ? process.env.ADMIN_URL || null : '/admin';
  next();
});

if (!ADMIN_PORT) {
  // Default: the admin panel lives at /admin on the same server.
  app.use('/admin', createAdminApp({ base: '/admin', mounted: true }));
}
app.use(publicRouter);
errorHandlers(app, 'error');

app.listen(PORT, () => {
  console.log(`Site running at http://localhost:${PORT}`);
  if (!ADMIN_PORT) console.log(`Admin panel at  http://localhost:${PORT}/admin`);
});

if (ADMIN_PORT) {
  // Fully separate admin server (e.g. only reachable on a private network / VPN).
  const admin = createAdminApp({ base: '', publicUrl: PUBLIC_URL || `http://localhost:${PORT}` });
  admin.listen(ADMIN_PORT, () => console.log(`Admin panel at  http://localhost:${ADMIN_PORT}`));
}
