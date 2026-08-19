/**
 * Booru/forum-style homepage.
 *
 * A dense grid of posts with a sidebar of live site activity, instead of
 * the big hero and eight cards. Selected with HOMEPAGE_LAYOUT=forum, so
 * both layouts live in one codebase and the switch is an env var rather
 * than a branch.
 *
 * The reference design has accounts, tags and a forum, none of which this
 * site has. Rather than fake them, each panel is mapped to something the
 * site really tracks:
 *
 *   Dailyjak      -> the daily award post
 *   Featured Post -> the existing `featured` flag
 *   Recent Comments -> real comments, linked to their posts
 *   Random Gem    -> a random visible post
 *   Popular Tags  -> there are no tags, so: real counters
 *
 * Anything with no data renders as an honest empty state rather than a
 * placeholder pretending to be content.
 */
// One page size, no picker. Fifty fills the grid without turning the front
// page into an endless scroll, and a chooser for something nobody changes
// is just another control in the way.
const DEFAULT_PAGE_SIZE = 50;

function clampPageSize() {
  return DEFAULT_PAGE_SIZE;
}

/** Comment bodies in the sidebar are one line of preview, not the whole
 * essay - the panel has to stay a sidebar. */
function truncate(text, limit) {
  const value = String(text || "").trim();
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function timeAgo(date, t) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 1000));
  const units = [
    [31536000, "y"],
    [2592000, "mo"],
    [86400, "d"],
    [3600, "h"],
    [60, "min"]
  ];
  for (const [size, suffix] of units) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${suffix}`;
  }
  return `${seconds}s`;
}

/**
 * Builds the page. Everything it needs is passed in - this module does no
 * database access of its own, so it stays testable and the query plan
 * stays visible at the call site.
 */
function render({
  t,
  req,
  escapeHtml,
  withLang,
  posts,
  total,
  page,
  perPage,
  daily,
  featured,
  random,
  comments,
  stats,
  thumbFor,
  hrefFor,
  formatDate,
  // Prebuilt chunks from the caller. The layout decides where they go;
  // the route decides what is in them, so the two stay separable.
  heroHtml = "",
  sortNavHtml = "",
  meterHtml = "",
  appHtml = ""
}) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));

  const tile = (post) => {
    const thumb = thumbFor(post);
    return `
      <a class="fx-tile" href="${withLang(req, `/post/${post.id}`)}">
        <span class="fx-thumb">${
          thumb
            ? `<img src="${escapeHtml(thumb)}" alt="${escapeHtml(post.title)}" loading="lazy">`
            : `<span class="fx-thumb-text">${escapeHtml(truncate(post.title, 90))}</span>`
        }</span>
        <span class="fx-tile-foot">
          <span class="fx-tile-title">${escapeHtml(truncate(post.title, 42))}</span>
          <span class="fx-tile-date" title="${escapeHtml(timeAgo(post.created_at, t))}">${escapeHtml(formatDate(post.created_at))}</span>
          <span class="fx-tile-meta">
            <span class="fx-score">&#9650; ${post.upvotes || 0}</span>
            <span class="fx-score">&#9660; ${post.downvotes || 0}</span>
            <span class="fx-score">&#128172; ${post.comment_count || 0}</span>
          </span>
        </span>
      </a>`;
  };

  const panel = (title, inner, extra = "", id = "") => `
    <section class="fx-panel"${""}${id ? ` id="${id}"` : ""}>
      <h2 class="fx-panel-head">${escapeHtml(title)}${extra}</h2>
      <div class="fx-panel-body">${inner}</div>
    </section>`;

  const postPanel = (post) =>
    post
      ? `<a class="fx-panel-post" href="${withLang(req, `/post/${post.id}`)}">
           ${thumbFor(post) ? `<img src="${escapeHtml(thumbFor(post))}" alt="${escapeHtml(post.title)}" loading="lazy">` : ""}
           <span class="fx-panel-post-title">${escapeHtml(truncate(post.title, 60))}</span>
         </a>`
      : `<p class="fx-empty">${escapeHtml(t.forumNothingYet)}</p>`;

  const commentList = comments.length
    ? comments
        .map(
          (comment) => `
          <a class="fx-comment" href="${withLang(req, `/post/${comment.post_id}`)}">
            <span class="fx-comment-post">${escapeHtml(truncate(comment.post_title, 34))}</span>
            <span class="fx-comment-body">${escapeHtml(truncate(comment.body, 76))}</span>
            <span class="fx-ago">${timeAgo(comment.created_at, t)}</span>
          </a>`
        )
        .join("")
    : `<p class="fx-empty">${escapeHtml(t.forumNothingYet)}</p>`;

  const pageLink = (target, label, disabled = false, current = false) =>
    disabled
      ? `<span class="fx-page fx-page-off">${label}</span>`
      : `<a class="fx-page${current ? " fx-page-on" : ""}" href="${hrefFor(target, perPage)}">${label}</a>`;

  // A window around the current page, so 3,890 pages does not render 3,890
  // links. Same idea as the existing gallery pager.
  const windowStart = Math.max(1, Math.min(page - 2, totalPages - 4));
  const windowEnd = Math.min(totalPages, Math.max(page + 2, 5));
  const numbered = [];
  for (let i = windowStart; i <= windowEnd; i++) numbered.push(pageLink(i, String(i), false, i === page));

  return `
    ${heroHtml}
    <div class="fx">
      ${sortNavHtml}
      <aside class="fx-side">
        ${panel(t.forumDaily, postPanel(daily))}
        ${panel(t.forumFeatured, postPanel(featured))}
        ${panel(
          t.forumRecentComments,
          commentList,
          `<a class="fx-panel-link" href="${withLang(req, "/gallery")}">${escapeHtml(t.forumViewAll)}</a>`
        )}
        ${panel(t.forumRandomGem, postPanel(random), `<a class="fx-panel-link" href="${hrefFor(page, perPage)}">${escapeHtml(t.forumReroll)}</a>`)}
        ${meterHtml ? panel(t.meterTitle, meterHtml) : ""}
        ${appHtml ? panel(t.appHeading, appHtml, "", "app") : ""}
        ${panel(
          t.forumStats,
          `<ul class="fx-stats">
             <li><span>${escapeHtml(t.visitors)}</span><b>${stats.visits.toLocaleString("en-US")}</b></li>
             <li><span>${escapeHtml(t.archived)}</span><b>${stats.uploads.toLocaleString("en-US")}</b></li>
             <li><span>${escapeHtml(t.metricsTotalVotes)}</span><b>${stats.votes.toLocaleString("en-US")}</b></li>
             <li><span>${escapeHtml(t.commentsHeading || "Comments")}</span><b>${stats.comments.toLocaleString("en-US")}</b></li>
           </ul>`
        )}
      </aside>

      <div class="fx-main">
        <div class="fx-grid">
          ${posts.length ? posts.map(tile).join("") : `<p class="fx-empty">${escapeHtml(t.emptyHome)}</p>`}
        </div>
      </div>

      <div class="fx-pager">
          <div class="fx-pages">
            ${pageLink(1, "&laquo;", page === 1)}
            ${pageLink(page - 1, "&lsaquo;", page === 1)}
            ${numbered.join("")}
            ${pageLink(page + 1, "&rsaquo;", page >= totalPages)}
            ${pageLink(totalPages, "&raquo;", page >= totalPages)}
            <span class="fx-page-of">/ ${totalPages}</span>
          </div>
      </div>
    </div>`;
}

module.exports = { render, clampPageSize, DEFAULT_PAGE_SIZE };
