import express, { Router } from 'express';
import { requireAuth } from './authentication.js';
import { serveAppAsset } from '../web/server/assets.js';
interface PageOptions {
  coversDirectory: string;
  onlineCoversDirectory: string;
  playerAssetPath: string;
  loginPage(): string;
  appPage(): string;
}
export function createPageRouter(options: PageOptions) {
  const router = Router();
router.get('/assets/app/:name', requireAuth, serveAppAsset);
router.use("/covers", requireAuth, express.static(options.coversDirectory, {
  maxAge: "30d",
  immutable: true,
}));

router.use("/online-covers", requireAuth, express.static(options.onlineCoversDirectory, {
  maxAge: "1d",
  immutable: false,
  setHeaders: (res) => res.setHeader("Cache-Control", "private, max-age=86400"),
}));

router.get("/assets/vendor/artplayer-5.4.0.js", requireAuth, (req, res, next) => {
  res.sendFile(options.playerAssetPath, {
    headers: {
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Type": "text/javascript; charset=utf-8",
    },
  }, (error) => {
    if (error) next(error);
  });
});

router.get("/login", (req, res) => {
  if (req.session.user) {
    res.redirect("/");
    return;
  }
  res.send(options.loginPage());
});

router.get("/", (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!req.session.user) {
    res.redirect("/login");
    return;
  }
  res.send(options.appPage());
});

  return router;
}
