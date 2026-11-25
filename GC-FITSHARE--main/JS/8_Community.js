/**
 * 8_Community.js — Community article feed
 * Channels, subscriptions (notification opt-in), user-shared articles,
 * and the admin RSS source manager + manual news fetch.
 */

let supabase;
let currentUser = null;
let currentUserProfile = null;
let isAdmin = false;

let channels = [];            // [{id, slug, name, description, sort_order}]
let subscribedChannelIds = new Set();
let allArticles = [];         // [{..., channel:{name,slug}, author:{...}}]
let activeChannelSlug = 'all';
let rssSources = [];

const ARTICLES_LIMIT = 100;

// ─── Init ────────────────────────────────────────────────────────────────────

async function initCommunity() {
    try {
        supabase = getSupabaseClient();
        currentUser = await checkUserAuthentication();
        if (!currentUser) {
            window.location.href = '/HTML/1_LogIn_Page.html';
            return;
        }

        await ensureUserExists(currentUser);
        if (await redirectIncompleteProfileSetup(currentUser)) return;
        isAdmin = await checkAdminStatus();

        try {
            const { data: profile } = await supabase
                .from('users')
                .select('full_name, username, email')
                .eq('id', currentUser.id)
                .maybeSingle();
            currentUserProfile = profile || null;
        } catch (_) { /* optional */ }

        setupEventListeners();

        await Promise.all([
            loadChannels(),
            loadSubscriptions(),
            loadArticles()
        ]);

        renderChannelTabs();
        populateChannelSelects();
        renderArticles();

        if (isAdmin) {
            document.getElementById('adminPanel').style.display = 'block';
            await loadRssSources();
        }
    } catch (error) {
        console.error('Community init error:', error);
        if (typeof CustomAlert !== 'undefined') {
            CustomAlert.show('Error', 'Failed to load the community page. Please refresh and try again.', 'error');
        }
    }
}

async function checkAdminStatus() {
    try {
        const { data: userData } = await supabase
            .from('users')
            .select('is_admin')
            .eq('id', currentUser.id)
            .maybeSingle();
        if (userData?.is_admin) return true;

        const { data: adminData } = await supabase
            .from('admins')
            .select('user_id')
            .eq('user_id', currentUser.id)
            .maybeSingle();
        return !!adminData;
    } catch (error) {
        console.error('Admin check error:', error);
        return false;
    }
}

// ─── Data loading ────────────────────────────────────────────────────────────

async function loadChannels() {
    const { data, error } = await supabase
        .from('community_channels')
        .select('id, slug, name, description, sort_order')
        .eq('is_active', true)
        .order('sort_order', { ascending: true });
    if (error) throw error;
    channels = data || [];
}

async function loadSubscriptions() {
    const { data, error } = await supabase
        .from('community_subscriptions')
        .select('channel_id')
        .eq('user_id', currentUser.id);
    if (error) {
        console.warn('Subscriptions load failed:', error.message || error);
        subscribedChannelIds = new Set();
        return;
    }
    subscribedChannelIds = new Set((data || []).map(r => r.channel_id));
}

async function loadArticles() {
    const list = document.getElementById('articlesList');
    try {
        let { data, error } = await supabase
            .from('community_articles')
            .select(`
                id, channel_id, title, summary, source_url, image_url,
                source_name, author_id, is_auto, published_at, created_at,
                channel:community_channels(name, slug),
                author:users(full_name, username)
            `)
            .order('published_at', { ascending: false })
            .limit(ARTICLES_LIMIT);

        if (error) {
            // Fallback without embeds if the relationship hint fails.
            ({ data, error } = await supabase
                .from('community_articles')
                .select('id, channel_id, title, summary, source_url, image_url, source_name, author_id, is_auto, published_at, created_at')
                .order('published_at', { ascending: false })
                .limit(ARTICLES_LIMIT));
        }
        if (error) throw error;

        allArticles = (data || []).map(a => ({
            ...a,
            channel_name: a.channel?.name || channelNameById(a.channel_id),
            channel_slug: a.channel?.slug || channelSlugById(a.channel_id),
            author_name: a.author?.full_name || a.author?.username || null
        }));
    } catch (err) {
        console.error('Articles load error:', err);
        list.innerHTML = '<div class="empty-state">Failed to load articles. Please try again later.</div>';
        return;
    }
    renderArticles();
}

function channelNameById(id) {
    return channels.find(c => c.id === id)?.name || 'Community';
}
function channelSlugById(id) {
    return channels.find(c => c.id === id)?.slug || '';
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderChannelTabs() {
    const wrap = document.getElementById('channelTabs');
    if (!wrap) return;

    const allCount = allArticles.length;
    let html = `
        <button type="button" class="channel-tab ${activeChannelSlug === 'all' ? 'active' : ''}" data-slug="all">
            All
            <span style="opacity:.7;font-size:.78rem;">(${allCount})</span>
        </button>`;

    for (const ch of channels) {
        const count = allArticles.filter(a => a.channel_id === ch.id).length;
        const subbed = subscribedChannelIds.has(ch.id);
        html += `
        <button type="button" class="channel-tab ${activeChannelSlug === ch.slug ? 'active' : ''}" data-slug="${escapeHtml(ch.slug)}">
            ${escapeHtml(ch.name)}
            <span style="opacity:.7;font-size:.78rem;">(${count})</span>
            <span class="subscribe-btn ${subbed ? 'subscribed' : ''}" data-channel-id="${ch.id}" role="button" title="${subbed ? 'Unsubscribe from notifications' : 'Subscribe for notifications'}" aria-label="Toggle subscription">
                <svg viewBox="0 0 24 24" fill="${subbed ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>
            </span>
        </button>`;
    }
    wrap.innerHTML = html;

    wrap.querySelectorAll('.channel-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            if (e.target.closest('.subscribe-btn')) return; // handled separately
            activeChannelSlug = tab.dataset.slug;
            renderChannelTabs();
            renderArticles();
        });
    });

    wrap.querySelectorAll('.subscribe-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await toggleSubscription(btn.dataset.channelId, btn);
        });
    });
}

function renderArticles() {
    const list = document.getElementById('articlesList');
    if (!list) return;

    const filtered = activeChannelSlug === 'all'
        ? allArticles
        : allArticles.filter(a => a.channel_slug === activeChannelSlug || channelSlugById(a.channel_id) === activeChannelSlug);

    if (!filtered.length) {
        list.innerHTML = '<div class="empty-state">No articles here yet. Check back soon — or share one yourself!</div>';
        return;
    }

    list.innerHTML = filtered.map(a => {
        const canDelete = isAdmin || (currentUser && a.author_id === currentUser.id);
        const img = a.image_url
            ? `<img class="article-image" src="${escapeHtml(a.image_url)}" alt="" loading="lazy" onerror="this.style.display='none'">`
            : '';
        const readLink = a.source_url
            ? `<a class="read-link" href="${escapeHtml(a.source_url)}" target="_blank" rel="noopener noreferrer">Read article ↗</a>`
            : '';
        const authorLabel = a.is_auto
            ? `<span class="article-source">${escapeHtml(a.source_name || 'News feed')}</span><span class="article-auto-tag">· auto-imported</span>`
            : `<span class="article-source">${escapeHtml(a.author_name || 'Community member')}</span>`;

        return `
        <article class="article-card">
            <a class="article-card-link" href="${escapeHtml(a.source_url || '#')}" ${a.source_url ? 'target="_blank" rel="noopener noreferrer"' : ''}>
                ${img}
                <div class="article-body">
                    <div class="article-meta">
                        <span class="channel-badge">${escapeHtml(a.channel_name || 'Community')}</span>
                        ${authorLabel}
                        <span>· ${formatDate(a.published_at)}</span>
                    </div>
                    <h3 class="article-title">${escapeHtml(a.title)}</h3>
                    ${a.summary ? `<p class="article-summary">${escapeHtml(a.summary)}</p>` : ''}
                </div>
            </a>
            <div class="article-actions" style="padding:0 18px 14px;">
                ${readLink}
                ${canDelete ? `<button type="button" class="article-delete-btn" data-id="${a.id}">Delete</button>` : ''}
            </div>
        </article>`;
    }).join('');

    list.querySelectorAll('.article-delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            await deleteArticle(btn.dataset.id);
        });
    });
}

// ─── Subscriptions ───────────────────────────────────────────────────────────

async function toggleSubscription(channelId, btn) {
    const subbed = subscribedChannelIds.has(channelId);
    try {
        if (subbed) {
            const { error } = await supabase
                .from('community_subscriptions')
                .delete()
                .eq('user_id', currentUser.id)
                .eq('channel_id', channelId);
            if (error) throw error;
            subscribedChannelIds.delete(channelId);
            showNotification('Unsubscribed — you won\'t get notifications for this channel.');
        } else {
            const { error } = await supabase
                .from('community_subscriptions')
                .insert({ user_id: currentUser.id, channel_id: channelId });
            if (error) throw error;
            subscribedChannelIds.add(channelId);
            showNotification('Subscribed! You\'ll be notified about new articles in this channel.');
        }
        renderChannelTabs();
    } catch (err) {
        console.error('Subscription toggle error:', err);
        if (typeof CustomAlert !== 'undefined') {
            CustomAlert.show('Error', 'Could not update subscription. Please try again.', 'error');
        }
    }
}

// ─── Share article ───────────────────────────────────────────────────────────

function populateChannelSelects() {
    const options = channels.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    ['articleChannel', 'rssChannel'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = options;
    });
}

async function submitArticle(e) {
    e.preventDefault();
    const btn = document.getElementById('submitArticleBtn');
    btn.disabled = true;
    btn.textContent = 'Sharing…';

    try {
        const title = document.getElementById('articleTitle').value.trim();
        const channelId = document.getElementById('articleChannel').value;
        const summary = document.getElementById('articleSummary').value.trim();
        const sourceUrl = document.getElementById('articleUrl').value.trim();
        const imageUrl = document.getElementById('articleImage').value.trim();

        if (!title || !channelId) {
            if (typeof CustomAlert !== 'undefined') CustomAlert.show('Missing info', 'Please fill in the title and channel.', 'warning');
            return;
        }

        // Reuse the platform AI moderation before publishing.
        const moderation = await analyzeContentWithGemini(title, summary || sourceUrl, [], { contentType: 'post' });
        if (!moderation.approved) {
            await logAiModerationAttempt({
                userId: currentUser.id,
                preview: `[community article] ${title}`,
                reason: moderation.reason || 'Rejected by moderation',
                contentType: 'post'
            });
            if (typeof CustomAlert !== 'undefined') {
                CustomAlert.show('Article not shared', moderation.reason || 'This article did not pass content review.', 'warning');
            }
            return;
        }

        const authorName = currentUserProfile?.full_name || currentUserProfile?.username || 'Community member';
        const { error } = await supabase.from('community_articles').insert({
            channel_id: channelId,
            title,
            summary,
            source_url: sourceUrl,
            image_url: imageUrl,
            source_name: `Shared by ${authorName}`,
            author_id: currentUser.id,
            is_auto: false,
            published_at: new Date().toISOString()
        });
        if (error) throw error;

        closeShareModal();
        document.getElementById('shareArticleForm').reset();
        showNotification('Article shared to the community!');
        await loadArticles();
        renderChannelTabs(); // refresh counts
    } catch (err) {
        console.error('Share article error:', err);
        if (typeof CustomAlert !== 'undefined') {
            CustomAlert.show('Share failed', err?.message || 'Could not share the article. Please try again.', 'error');
        }
    } finally {
        btn.disabled = false;
        btn.textContent = 'Share';
    }
}

async function deleteArticle(id) {
    let proceed = true;
    if (typeof CustomAlert !== 'undefined' && typeof CustomAlert.confirm === 'function') {
        proceed = await CustomAlert.confirm('Delete article', 'Delete this article? This cannot be undone.', { confirmText: 'Delete', cancelText: 'Cancel', danger: true });
    } else {
        proceed = confirm('Delete this article? This cannot be undone.');
    }
    if (!proceed) return;

    try {
        const { error } = await supabase.from('community_articles').delete().eq('id', id);
        if (error) throw error;
        showNotification('Article deleted.');
        await loadArticles();
        renderChannelTabs();
    } catch (err) {
        console.error('Delete article error:', err);
        if (typeof CustomAlert !== 'undefined') CustomAlert.show('Delete failed', 'Could not delete the article.', 'error');
    }
}

function openShareModal() {
    document.getElementById('shareArticleModal')?.classList.remove('hidden');
}
function closeShareModal() {
    document.getElementById('shareArticleModal')?.classList.add('hidden');
}

// ─── Admin: RSS sources ──────────────────────────────────────────────────────

async function loadRssSources() {
    const wrap = document.getElementById('rssSourcesList');
    if (!wrap) return;
    wrap.innerHTML = '<div class="loading-state" style="padding:20px;">Loading sources…</div>';

    const { data, error } = await supabase
        .from('community_rss_sources')
        .select('id, channel_id, feed_url, name, is_active, last_fetched_at, created_at, channel:community_channels(name)')
        .order('created_at', { ascending: true });

    if (error) {
        console.error('RSS sources load error:', error);
        wrap.innerHTML = '<div class="empty-state" style="padding:20px;">Could not load RSS sources.</div>';
        return;
    }
    rssSources = data || [];
    renderRssSources();
}

function renderRssSources() {
    const wrap = document.getElementById('rssSourcesList');
    if (!wrap) return;

    if (!rssSources.length) {
        wrap.innerHTML = '<div class="empty-state" style="padding:20px;">No RSS sources yet. Add one above.</div>';
        return;
    }

    wrap.innerHTML = rssSources.map(s => {
        const chName = s.channel?.name || channelNameById(s.channel_id);
        const lastFetch = s.last_fetched_at ? formatDate(s.last_fetched_at) : 'never';
        return `
        <div class="rss-source-row" data-id="${s.id}">
            <div class="rss-source-info">
                <div class="rss-source-name">${escapeHtml(s.name || 'Unnamed source')}</div>
                <div class="rss-source-url">${escapeHtml(s.feed_url)}</div>
                <div class="rss-source-meta">→ ${escapeHtml(chName)} · last fetched ${escapeHtml(lastFetch)}</div>
            </div>
            <div class="rss-source-actions">
                <span class="status-badge ${s.is_active ? 'active' : 'inactive'}">${s.is_active ? 'Active' : 'Paused'}</span>
                <button type="button" class="mini-btn" data-action="toggle">${s.is_active ? 'Pause' : 'Resume'}</button>
                <button type="button" class="mini-btn danger" data-action="delete">Delete</button>
            </div>
        </div>`;
    }).join('');

    wrap.querySelectorAll('.rss-source-row').forEach(row => {
        const id = row.dataset.id;
        row.querySelector('[data-action="toggle"]')?.addEventListener('click', () => toggleRssSource(id));
        row.querySelector('[data-action="delete"]')?.addEventListener('click', () => deleteRssSource(id));
    });
}

async function addRssSource(e) {
    e.preventDefault();
    const name = document.getElementById('rssName').value.trim();
    const channelId = document.getElementById('rssChannel').value;
    const feedUrl = document.getElementById('rssUrl').value.trim();

    if (!channelId || !feedUrl) return;

    try {
        const { error } = await supabase.from('community_rss_sources').insert({
            channel_id: channelId,
            feed_url: feedUrl,
            name,
            is_active: true,
            created_by: currentUser.id
        });
        if (error) throw error;
        document.getElementById('rssSourceForm').reset();
        populateChannelSelects();
        showNotification('RSS source added. It will be fetched by the daily job.');
        await loadRssSources();
    } catch (err) {
        console.error('Add RSS source error:', err);
        const msg = /duplicate|unique/i.test(err?.message || '') ? 'That feed URL is already added.' : (err?.message || 'Could not add source.');
        if (typeof CustomAlert !== 'undefined') CustomAlert.show('Add failed', msg, 'error');
    }
}

async function toggleRssSource(id) {
    const src = rssSources.find(s => s.id === id);
    if (!src) return;
    try {
        const { error } = await supabase
            .from('community_rss_sources')
            .update({ is_active: !src.is_active })
            .eq('id', id);
        if (error) throw error;
        await loadRssSources();
    } catch (err) {
        console.error('Toggle RSS source error:', err);
    }
}

async function deleteRssSource(id) {
    let proceed = true;
    if (typeof CustomAlert !== 'undefined' && typeof CustomAlert.confirm === 'function') {
        proceed = await CustomAlert.confirm('Delete source', 'Remove this RSS source? Articles already imported will stay.', { confirmText: 'Delete', cancelText: 'Cancel', danger: true });
    } else {
        proceed = confirm('Remove this RSS source?');
    }
    if (!proceed) return;
    try {
        const { error } = await supabase.from('community_rss_sources').delete().eq('id', id);
        if (error) throw error;
        await loadRssSources();
    } catch (err) {
        console.error('Delete RSS source error:', err);
    }
}

async function fetchNewsNow() {
    const btn = document.getElementById('fetchNowBtn');
    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = 'Fetching…';
    try {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData?.session?.access_token || '';
        const { data, error } = await supabase.functions.invoke('fetch-community-news', {
            headers: token ? { Authorization: `Bearer ${token}` } : undefined
        });
        if (error) throw error;
        showNotification(`Done — ${data?.inserted ?? 0} new article(s) imported.`);
        await loadArticles();
        renderChannelTabs();
        await loadRssSources(); // refresh last_fetched_at
    } catch (err) {
        console.error('Fetch news error:', err);
        if (typeof CustomAlert !== 'undefined') {
            CustomAlert.show('Fetch failed', err?.message || 'Could not run the news fetch. Is the edge function deployed?', 'error');
        }
    } finally {
        btn.disabled = false;
        btn.textContent = oldText;
    }
}

// ─── Events ──────────────────────────────────────────────────────────────────

function setupEventListeners() {
    document.getElementById('shareArticleBtn')?.addEventListener('click', openShareModal);
    document.getElementById('closeShareModal')?.addEventListener('click', closeShareModal);
    document.getElementById('cancelShareBtn')?.addEventListener('click', closeShareModal);
    document.getElementById('shareArticleModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'shareArticleModal') closeShareModal();
    });
    document.getElementById('shareArticleForm')?.addEventListener('submit', submitArticle);

    document.getElementById('rssSourceForm')?.addEventListener('submit', addRssSource);
    document.getElementById('fetchNowBtn')?.addEventListener('click', fetchNewsNow);
}

document.addEventListener('DOMContentLoaded', initCommunity);
