import { Router, type Request, type Response } from "express";
import { isDraining } from "./health.ts";
import { readViewerId } from "./auth/request.ts";
import { canOpenLiveStream, openLiveStream, type LiveAudience } from "./live-events.ts";

const router = Router();

export function serveLiveStream(req: Request, res: Response, audience: LiveAudience = "feed") {
  if (isDraining() || !canOpenLiveStream()) {
    res.set("Retry-After", "5").status(503).json({ error: "live_unavailable" });
    return;
  }
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  res.status(200).set({
    "Content-Type": "text/event-stream",
    "Content-Encoding": "identity",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  openLiveStream(res, audience);
}

router.get("/", async (req, res) => {
  const viewerId = await readViewerId(req);
  serveLiveStream(req, res, viewerId ? { feedFor: viewerId } : "feed");
});

export default router;
