const { toIsoUtc } = require("./util");

function serializePost(row, origin) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || null,
    kind: row.kind,
    image_url: row.filename ? `${origin}/uploads/${encodeURIComponent(row.filename)}` : null,
    featured: !!row.featured,
    pinned: !!row.pinned,
    created_at: toIsoUtc(row.created_at),
    upvotes: row.upvotes || 0,
    downvotes: row.downvotes || 0
  };
}

module.exports = { serializePost };
