import { Router } from "express";
import { isDraining } from "./health.ts";
import { canOpenLiveStream, openLiveStream } from "./live-events.ts";

const router = Router();

router.get("/", (req, res) => {
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
  openLiveStream(res);
});

export default router;
