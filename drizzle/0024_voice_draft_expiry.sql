-- Earlier voice uploads were staged for one hour. Keep their original upload
-- time while reducing the lifetime to thirty minutes. Due deletion jobs stay due.
UPDATE media_deletions
SET available_at = available_at - interval '30 minutes'
WHERE key LIKE 'voices/%' AND attempts = 0 AND available_at > now();
