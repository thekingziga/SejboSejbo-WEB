const storage = require("./storage");
const { toIsoUtc } = require("./util");

/** `myVote` is undefined when the caller sent no X-Device-Id. In that case
 * the field is omitted entirely rather than sent as 0 - "you haven't voted"
 * and "I don't know who you are" are different answers, and a client that
 * can't tell them apart would render an unvoted state it isn't entitled to
 * claim. */
function serializePost(row, origin, myVote) {
  const post = {
    id: row.id,
    title: row.title,
    description: row.description || null,
    kind: row.kind,
    image_url: storage.publicUrl(row.filename, origin),
    featured: !!row.featured,
    pinned: !!row.pinned,
    created_at: toIsoUtc(row.created_at),
    upvotes: row.upvotes || 0,
    downvotes: row.downvotes || 0,
    comment_count: row.comment_count || 0
  };
  if (myVote !== undefined) post.my_vote = myVote;
  return post;
}

module.exports = { serializePost };
