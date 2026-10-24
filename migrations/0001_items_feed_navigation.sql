-- Covers per-feed navigation unread and saved counts without fetching item rows.
CREATE INDEX items_feed_navigation_idx ON items (feed_id, read_at, is_saved);
