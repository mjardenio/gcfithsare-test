/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 2_Main_Feed.js — HOME FEED (posts, comments, votes, search, notifications)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PURPOSE 
 *   Main social feed: load posts, filters, create post, AI moderation hook,
 *   comments tree, bookmarks, reports, wellness prompts, recommendations.
 *
 * DEPENDS ON 
 *   0_Utilities.js, 0_Footer.js, 0_Alerts.js; optional 0_AI_* for moderation.
 *
 * SECTIONS (search for these `// ───` headers in this file)
 *   Globals | Init | Load Posts | Display & Filter | Trending | Create Post Card
 *   Bookmarks | Voting | Comments | Report | Share | Delete | Menu | Create Post
 *   Hashtags | Image handling | Utility | Event Listeners | Wellness | Recommendations
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ─── Globals ─────────────────────────────────────────────────────────────────
let supabase;
let currentUser  = null;
let currentFilter = 'hot';
let currentCategory = 'all';
let allPosts     = [];
let hashtags     = [];
let selectedImageFile = null;
let currentPostIdToReport = null;
let notificationsFeatureAvailable = true;
/** Supabase Realtime channel for live unread badge updates */
let notificationBadgeChannel = null;
let userSearchResults = [];
let userSearchRequestToken = 0;
let postSearchResults = [];
let searchSuggestionQuery = '';
let currentUserIsExpert = false;
let currentUserIsAdmin = false;
let expertWeeklyRemaining = 0;
/** sessionStorage: open feed post/comments from notification clicks */
const GCFS_NOTIF_NAV_KEY = 'gcfs_notif_nav';

function getWellnessSkipKey() {
    return currentUser?.id
        ? `gcfitshare_wellness_shown_${currentUser.id}`
        : 'gcfitshare_wellness_shown_guest';
}

async function hydrateExpertEndorseState() {
    currentUserIsExpert = false;
    currentUserIsAdmin = false;
    expertWeeklyRemaining = 0;
    if (!currentUser?.id || !supabase) return;
    const { data, error } = await supabase
        .from('users')
        .select('is_expert, is_admin')
        .eq('id', currentUser.id)
        .maybeSingle();
    if (error) {
        console.warn('Expert state:', error.message || error);
        return;
    }
    currentUserIsExpert = !!data?.is_expert;
    currentUserIsAdmin = !!data?.is_admin;
    if (!currentUserIsAdmin && currentUser.id) {
        const { data: adm } = await supabase
            .from('admins')
            .select('id')
            .eq('user_id', currentUser.id)
            .maybeSingle();
        currentUserIsAdmin = !!adm?.id;
    }
    if (!currentUserIsExpert || typeof countExpertEndorsementsThisWeek !== 'function') return;
    const used = await countExpertEndorsementsThisWeek(supabase, currentUser.id);
    const lim = typeof getExpertWeeklyEndorsementLimit === 'function' ? getExpertWeeklyEndorsementLimit() : 3;
    expertWeeklyRemaining = Math.max(0, lim - used);
}

function navigateToUserProfile(userId) {
    if (!userId) return;
    if (userId === currentUser?.id) {
        window.location.href = '/HTML/3_Profile.html';
        return;
    }
    window.location.href = `/HTML/3_Profile.html?user=${encodeURIComponent(userId)}`;
}

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    supabase    = getSupabaseClient();
    currentUser = await checkUserAuthentication();
    if (currentUser) {
        if (await redirectIncompleteProfileSetup(currentUser)) return;
        if (typeof hydrateAdminNavVisibility === 'function') {
            void hydrateAdminNavVisibility();
        }
        await hydrateExpertEndorseState();
        await loadPosts();
        await tryConsumeNotificationDeepLink();
        setupEventListeners();
        wireExpertPendingBannerDismiss();
        await maybeShowExpertApplicationPendingBanner();
        await checkAndShowWellnessProfile();
        await markSavedBookmarks();
        await loadNotificationBadge();
        startNotificationRealtimeSubscription();
    }
});

function wireExpertPendingBannerDismiss() {
    const btn = document.getElementById('expertPendingBannerDismiss');
    if (!btn || btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
        document.getElementById('expertApplicationPendingBanner')?.classList.add('hidden');
        if (currentUser?.id) {
            sessionStorage.setItem(`gcfitshare_expert_pending_banner_dismissed_${currentUser.id}`, '1');
        }
    });
}

async function maybeShowExpertApplicationPendingBanner() {
    const el = document.getElementById('expertApplicationPendingBanner');
    if (!el || !currentUser?.id) return;
    if (sessionStorage.getItem(`gcfitshare_expert_pending_banner_dismissed_${currentUser.id}`) === '1') {
        return;
    }
    try {
        const { data, error } = await supabase
            .from('expert_applications')
            .select('status')
            .eq('user_id', currentUser.id)
            .order('submitted_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error || !data) return;
        const st = String(data.status || 'pending').toLowerCase().trim();
        if (st !== 'pending' && st !== 'under_review' && st !== 'reviewing') return;
        el.classList.remove('hidden');
    } catch (err) {
        console.warn('Expert pending banner:', err?.message || err);
    }
}

async function loadNotificationBadge() {
    const notificationBtn = document.querySelector('.notification-btn');
    if (!notificationBtn) return;

    const existing = notificationBtn.querySelector('.notification-badge');
    if (existing) existing.remove();

    try {
        const { count, error } = await supabase
            .from('notifications')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', currentUser.id)
            .eq('is_read', false);
        if (error) throw error;

        const unread = count || 0;
        if (!unread) return;

        const badge = document.createElement('span');
        badge.className = 'notification-badge';
        badge.textContent = unread > 99 ? '99+' : String(unread);
        badge.style.cssText = `
            position:absolute;
            top:-6px;
            right:-6px;
            min-width:18px;
            height:18px;
            padding:0 4px;
            border-radius:999px;
            background:#e74c3c;
            color:white;
            font-size:10px;
            font-weight:700;
            display:flex;
            align-items:center;
            justify-content:center;
        `;
        notificationBtn.style.position = 'relative';
        notificationBtn.appendChild(badge);
        notificationsFeatureAvailable = true;
    } catch (err) {
        notificationsFeatureAvailable = false;
        console.warn('Notifications unavailable:', err?.message || err);
    }
}

function stopNotificationRealtimeSubscription() {
    if (!supabase || !notificationBadgeChannel) return;
    try {
        supabase.removeChannel(notificationBadgeChannel);
    } catch (e) {
        console.warn('Notification realtime teardown:', e?.message || e);
    }
    notificationBadgeChannel = null;
}

/**
 * Subscribes to INSERT/UPDATE/DELETE on this user's notifications so the bell badge
 * updates without a full page reload. Requires Realtime enabled for `notifications` in Supabase.
 */
function startNotificationRealtimeSubscription() {
    stopNotificationRealtimeSubscription();
    if (!supabase || !currentUser?.id) return;

    const uid = currentUser.id;
    const channel = supabase
        .channel(`notifications-badge-${uid}`)
        .on(
            'postgres_changes',
            {
                event: '*',
                schema: 'public',
                table: 'notifications',
                filter: `user_id=eq.${uid}`
            },
            () => {
                void loadNotificationBadge();
            }
        )
        .subscribe((status) => {
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                console.warn('Notification realtime subscription:', status);
            }
        });

    notificationBadgeChannel = channel;
}

function ensureNotificationsModal() {
    let modal = document.getElementById('notificationsModal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'notificationsModal';
    modal.className = 'modal hidden';
    modal.innerHTML = `
        <div class="modal-content" style="max-width:560px;">
            <div class="modal-header">
                <h2>Notifications</h2>
                <button class="modal-close" id="closeNotificationsModal">&times;</button>
            </div>
            <div class="modal-body">
                <div style="display:flex;justify-content:flex-end;margin-bottom:12px;">
                    <button id="markAllNotificationsReadBtn" class="btn-secondary" style="padding:8px 12px;font-size:12px;">Mark all as read</button>
                </div>
                <div id="notificationsList">
                    <p style="text-align:center;color:#636e72;">Loading notifications...</p>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('closeNotificationsModal')?.addEventListener('click', () => {
        modal.classList.add('hidden');
    });
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.add('hidden');
    });
    document.getElementById('markAllNotificationsReadBtn')?.addEventListener('click', markAllNotificationsRead);

    return modal;
}

async function openNotificationsModal() {
    const modal = ensureNotificationsModal();
    const list = document.getElementById('notificationsList');
    if (!list) return;

    modal.classList.remove('hidden');

    if (!notificationsFeatureAvailable) {
        list.innerHTML = `<p style="text-align:center;color:#636e72;">Notifications are not configured yet.</p>`;
        return;
    }

    list.innerHTML = `<p style="text-align:center;color:#636e72;">Loading notifications...</p>`;

    try {
        const selectRich = `
                id,
                title,
                message,
                type,
                is_read,
                created_at,
                post_id,
                comment_id,
                actor:actor_id (
                    id,
                    full_name,
                    username
                )
            `;
        let { data, error } = await supabase
            .from('notifications')
            .select(selectRich)
            .eq('user_id', currentUser.id)
            .order('created_at', { ascending: false })
            .limit(30);
        if (error && /post_id|comment_id|column|schema|Could not find/i.test(String(error.message || ''))) {
            ({ data, error } = await supabase
                .from('notifications')
                .select(`
                    id,
                    title,
                    message,
                    type,
                    is_read,
                    created_at,
                    actor:actor_id ( id, full_name, username )
                `)
                .eq('user_id', currentUser.id)
                .order('created_at', { ascending: false })
                .limit(30));
        }
        if (error) throw error;

        if (!data || !data.length) {
            list.innerHTML = `<p style="text-align:center;color:#636e72;">No notifications yet.</p>`;
            return;
        }

        list.innerHTML = data.map((n) => {
            const actorName = n.actor?.full_name || n.actor?.username || 'Someone';
            const time = formatDate(n.created_at);
            const notificationIcons = {
                post_like: '<path d="M7 10v12"/><path d="M15 5.9 14 10h5.6a2 2 0 0 1 1.9 2.6l-2.1 7A2 2 0 0 1 17.5 21H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h2.2l4-7a2 2 0 0 1 3.8.9Z"/>',
                post_downvote: '<path d="M7 14V2"/><path d="M15 18.1 14 14h5.6a2 2 0 0 0 1.9-2.6l-2.1-7A2 2 0 0 0 17.5 3H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2.2l4 7a2 2 0 0 0 3.8-.9Z"/>',
                comment: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>',
                comment_reply: '<path d="m9 17-5-5 5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
                follow: '<path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M20 8v6m3-3h-6"/>',
                admin_flagged_post: '<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="M12 8v4m0 4h.01"/>',
                community_article: '<path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8"/><path d="M15 18h-5"/><path d="M10 6h8v4h-8V6Z"/>'
            };
            const iconPath = notificationIcons[n.type] || '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M10 21h4"/>';
            const actionBtn = n.type === 'follow' && n.actor?.id
                ? `<button type="button" class="btn-primary notif-view-profile" data-user-id="${n.actor.id}" style="padding:6px 10px;font-size:12px;">View Profile</button>`
                : '';
            const hasPost = !!n.post_id;
            let jumpBtn = '';
            if (hasPost && n.type === 'comment_reply') {
                jumpBtn = `<button type="button" class="btn-secondary notif-open-thread" data-post-id="${n.post_id}" data-comment-id="${n.comment_id || ''}" style="padding:6px 10px;font-size:12px;">Open comments</button>`;
            } else if (hasPost && n.type === 'post_like') {
                jumpBtn = `<button type="button" class="btn-secondary notif-open-thread" data-post-id="${n.post_id}" data-comment-id="" data-open-post-only="1" style="padding:6px 10px;font-size:12px;">View post</button>`;
            }
            const communityBtn = n.type === 'community_article'
                ? `<button type="button" class="btn-secondary notif-open-community" style="padding:6px 10px;font-size:12px;">View in Community</button>`
                : '';
            const isUnread = !n.is_read;
            return `
                <div class="notif-card ${isUnread ? 'notif-unread' : 'notif-read'}">
                    <div class="notif-card-header">
                        <div class="notif-card-icon" aria-label="${escapeHtml(n.type || 'update')}" role="img"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPath}</svg></div>
                        <div class="notif-card-content">
                            <p class="notif-title">${escapeHtml(n.title || 'Notification')}</p>
                            <p class="notif-message">${escapeHtml(n.message || `${actorName} sent an update.`)}</p>
                        </div>
                        <small class="notif-time">${time}</small>
                    </div>
                    <div class="notif-card-actions">
                        ${jumpBtn}${actionBtn}${communityBtn}
                    </div>
                </div>`;
        }).join('');

        list.querySelectorAll('.notif-view-profile').forEach((btn) => {
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const userId = btn.getAttribute('data-user-id');
                if (!userId) return;
                if (userId === currentUser.id) {
                    window.location.href = '/HTML/3_Profile.html';
                } else {
                    window.location.href = `/HTML/3_Profile.html?user=${encodeURIComponent(userId)}`;
                }
            });
        });

        list.querySelectorAll('.notif-open-thread').forEach((btn) => {
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const postId = btn.getAttribute('data-post-id');
                if (!postId) return;
                const commentId = btn.getAttribute('data-comment-id') || '';
                const postOnly = btn.getAttribute('data-open-post-only') === '1';
                document.getElementById('notificationsModal')?.classList.add('hidden');
                const payload = {
                    postId,
                    commentId: commentId || null,
                    openComments: !postOnly
                };
                const onFeed = /2_Main_Feed\.html/i.test(window.location.pathname || '');
                if (onFeed && allPosts.some((p) => p.id === postId)) {
                    void runNotificationDeepLink(payload);
                } else {
                    queueNotificationDeepLinkAndGoFeed(payload);
                }
            });
        });

        list.querySelectorAll('.notif-open-community').forEach((btn) => {
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                document.getElementById('notificationsModal')?.classList.add('hidden');
                window.location.href = '/community';
            });
        });

        list.querySelectorAll('.notif-card').forEach((card) => {
            const btn = card.querySelector('.notif-open-thread');
            if (!btn) return;
            card.addEventListener('click', () => btn.click());
        });

        await markAllNotificationsRead(false);
    } catch (err) {
        console.error('Notifications load error:', err);
        list.innerHTML = `<p style="text-align:center;color:#e74c3c;">Failed to load notifications.</p>`;
    }
}

async function markAllNotificationsRead(showToast = true) {
    if (!notificationsFeatureAvailable) return;
    try {
        const { error } = await supabase
            .from('notifications')
            .update({ is_read: true })
            .eq('user_id', currentUser.id)
            .eq('is_read', false);
        if (error) throw error;
        await loadNotificationBadge();
        if (showToast) CustomAlert.show('Notifications', 'All notifications marked as read.', 'success');
    } catch (err) {
        console.error('Mark notifications read error:', err);
        if (showToast) CustomAlert.show('Error', 'Failed to update notifications.');
    }
}

const POST_FEED_COLUMN_LIST_FULL = [
    'id',
    'user_id',
    'title',
    'body',
    'category',
    'hashtags',
    'image_url',
    'created_at',
    'expert_endorsed_at',
    'expert_endorsed_by',
    'is_expert_approved'
];

const POST_FEED_COLUMN_LIST_NO_APPROVED_FLAG = [
    'id',
    'user_id',
    'title',
    'body',
    'category',
    'hashtags',
    'image_url',
    'created_at',
    'expert_endorsed_at',
    'expert_endorsed_by'
];

/**
 * If posts rows have no endorsement timestamps but expert_badge_user has a gift row (e.g. UPDATE was blocked by RLS),
 * fill expert_endorsed_at / is_expert_approved in-memory so the strip still renders after SQL 019 SELECT policy exists.
 */
async function enrichPostsExpertBadgeFromExpertTable(sb, posts) {
    try {
        if (!sb || !posts?.length) return;
        const ids = [];
        for (const p of posts) {
            if (p?.id && !p.expert_endorsed_at && !p.is_expert_approved) ids.push(p.id);
        }
        if (!ids.length) return;
        const { data, error } = await sb.from('expert_badge_user').select('post_id, gifted_at').in('post_id', ids);
        if (error || !data?.length) return;
        const firstGift = new Map();
        for (const row of data) {
            if (!row?.post_id || !row?.gifted_at) continue;
            if (!firstGift.has(row.post_id)) firstGift.set(row.post_id, row.gifted_at);
        }
        posts.forEach((p) => {
            const ga = firstGift.get(p.id);
            if (!ga || p.expert_endorsed_at) return;
            p.expert_endorsed_at = ga;
            p.is_expert_approved = true;
        });
    } catch {
        /* optional */
    }
}

// ─── Load Posts ───────────────────────────────────────────────────────────────
async function loadPosts() {
    const container = document.getElementById('postsContainer');
    try {
        let posts = null;
        let error = null;
        ({ data: posts, error } = await supabase
            .from('posts')
            .select(POST_FEED_COLUMN_LIST_FULL.join(', '))
            .eq('status', 'published')
            .order('created_at', { ascending: false })
            .limit(50));

        if (
            error &&
            (/is_expert_approved|column|status/i.test(String(error.message || '')))
        ) {
            // Fallback: remove problematic columns and status filter
            ({ data: posts, error } = await supabase
                .from('posts')
                .select(POST_FEED_COLUMN_LIST_NO_APPROVED_FLAG.join(', '))
                .order('created_at', { ascending: false })
                .limit(50));
            console.warn(
                'posts.status or is_expert_approved missing — running fallback query without status filter.'
            );
        }

        if (error) throw error;

        if (
            typeof localStorage !== 'undefined' &&
            localStorage.getItem('gcfitshare_debug') === '1'
        ) {
            console.info(
                '[GC FitShare] Post expert fields (first 3)',
                (posts || []).slice(0, 3).map((p) => ({
                    id: p?.id,
                    expert_endorsed_at: p?.expert_endorsed_at ?? null,
                    is_expert_approved: p?.is_expert_approved ?? null
                }))
            );
        }

        container.innerHTML = '';
        allPosts = posts || [];

        if (typeof mergePostsExpertBadgeFromRpc === 'function') {
            await mergePostsExpertBadgeFromRpc(supabase, allPosts);
        }
        await enrichPostsExpertBadgeFromExpertTable(supabase, allPosts);

        const adminIdSet =
            typeof fetchAdminUserIdsSet === 'function' ? await fetchAdminUserIdsSet(supabase) : new Set();

        if (allPosts.length > 0) {
            allPosts = await Promise.all(allPosts.map(async (post) => {
                try {
                    const [
                        { data: userData },
                        { count: upvotes },
                        { count: downvotes },
                        { count: commentCount }
                    ] = await Promise.all([
                        supabase
                            .from('users')
                            .select('id, full_name, email, avatar_url, username, course, is_expert, is_admin')
                            .eq('id', post.user_id)
                            .single(),
                        // FIX: use 'up' and 'down' not 'upvote'/'downvote'
                        supabase
                            .from('votes')
                            .select('*', { count: 'exact', head: true })
                            .eq('post_id', post.id)
                            .eq('vote_type', 'up'),
                        supabase
                            .from('votes')
                            .select('*', { count: 'exact', head: true })
                            .eq('post_id', post.id)
                            .eq('vote_type', 'down'),
                        supabase
                            .from('comments')
                            .select('*', { count: 'exact', head: true })
                            .eq('post_id', post.id)
                            .eq('is_deleted', false)
                    ]);

                    const baseUser = userData || {
                        id: post.user_id, full_name: '', email: '',
                        username: 'gc_student', course: ''
                    };
                    // RLS sometimes omits role flags on users; fill from session and admins roster when needed.
                    const mergedAdmin =
                        typeof mergeIsAdminFlag === 'function'
                            ? mergeIsAdminFlag(post.user_id, !!baseUser.is_admin, adminIdSet)
                            : !!baseUser.is_admin;
                    post.user = {
                        ...baseUser,
                        is_expert: !!(baseUser.is_expert) || (post.user_id === currentUser?.id && currentUserIsExpert),
                        is_admin: mergedAdmin || (post.user_id === currentUser?.id && currentUserIsAdmin)
                    };

                    post.upvotes_count   = upvotes      || 0;
                    post.downvotes_count = downvotes    || 0;
                    post.comments_count  = commentCount || 0;
                } catch (e) {
                    const mergedAdminErr =
                        typeof mergeIsAdminFlag === 'function'
                            ? mergeIsAdminFlag(post.user_id, false, adminIdSet)
                            : false;
                    post.user = {
                        id: post.user_id, full_name: '', username: 'gc_student', course: '',
                        is_expert: post.user_id === currentUser?.id && currentUserIsExpert,
                        is_admin:
                            mergedAdminErr || (post.user_id === currentUser?.id && currentUserIsAdmin)
                    };
                    post.upvotes_count   = 0;
                    post.downvotes_count = 0;
                    post.comments_count  = 0;
                }
                return post;
            }));
        }

        if (!allPosts.length) {
            container.innerHTML = '<p style="text-align:center;color:#636e72;padding:40px;">No posts yet. Be the first to share!</p>';
            return;
        }

        displayPostsByFilter(currentFilter);
        loadTrendingPosts();
    } catch (error) {
        console.error('Error loading posts:', error);
        container.innerHTML = `<p style="color:red;padding:20px;">Error loading posts: ${error.message}</p>`;
    }
}

// ─── Display & Filter ────────────────────────────────────────────────────────
function displayPostsByFilter(filter) {
    const container = document.getElementById('postsContainer');
    let filtered = [...allPosts];

    // Apply category filter
    if (currentCategory && currentCategory !== 'all') {
        filtered = filtered.filter(p => p.category === currentCategory);
    }

    switch (filter) {
        case 'recommended': {
            if (!filtered.length) {
                container.innerHTML =
                    '<p style="text-align:center;color:#636e72;padding:40px;">No posts in this category yet.</p>';
                return;
            }
            const lim = Math.min(Math.max(filtered.length, 12), 50);
            getPersonalizedRecommendations(filtered, lim).then((recommendedPosts) => {
                container.innerHTML = '';
                if (!recommendedPosts.length) {
                    container.innerHTML =
                        '<p style="text-align:center;color:#636e72;padding:40px;">No personalized recommendations yet. Add your lifestyle under <strong>Profile → Lifestyle &amp; For You</strong> or complete the setup on first visit.</p>';
                    return;
                }
                recommendedPosts.forEach((post) => container.appendChild(createPostElement(post)));
                markSavedBookmarks();
            });
            return;
        }
        case 'new':
            filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            break;
        case 'top':
            filtered.sort((a, b) => (b.upvotes_count || 0) - (a.upvotes_count || 0));
            break;
        case 'controversial':
            // most activity (up + down + comments) = controversial
            filtered.sort((a, b) => {
                const sA = (a.upvotes_count||0) + (a.downvotes_count||0) + (a.comments_count||0);
                const sB = (b.upvotes_count||0) + (b.downvotes_count||0) + (b.comments_count||0);
                return sB - sA;
            });
            break;
        case 'hot':
        default:
            filtered.sort((a, b) => {
                const sA = (a.upvotes_count||0) + (a.comments_count||0) * 2;
                const sB = (b.upvotes_count||0) + (b.comments_count||0) * 2;
                const tf = (new Date(b.created_at) - new Date(a.created_at)) / (1000*60*60*24);
                return (sB + tf * 10) - (sA + tf * 10);
            });
    }

    container.innerHTML = '';
    if (!filtered.length) {
        container.innerHTML = '<p style="text-align:center;color:#636e72;padding:40px;">No posts in this category yet.</p>';
        return;
    }
    filtered.forEach(post => container.appendChild(createPostElement(post)));
    markSavedBookmarks();
}

function getPostsMatchingSearch(query) {
    const q = query.toLowerCase().trim();
    if (!q) return [];
    const terms = q.match(/[a-z0-9]+/g)?.filter(term => term.length > 1) || [];
    const categoryKeywords = {
        fitness: ['fitness', 'workout', 'exercise', 'gym', 'training', 'cardio', 'strength', 'muscle', 'running'],
        nutrition: ['nutrition', 'diet', 'meal', 'food', 'protein', 'calorie', 'healthy', 'eating'],
        mental_wellness: ['mental', 'wellness', 'stress', 'anxiety', 'mindfulness', 'sleep', 'wellbeing'],
        productivity: ['productivity', 'focus', 'study', 'habit', 'routine', 'planning', 'time management']
    };
    const relatedCategories = new Set(
        Object.entries(categoryKeywords)
            .filter(([, keywords]) => terms.some(term => keywords.some(keyword => keyword.includes(term) || term.includes(keyword))))
            .map(([category]) => category)
    );
    return allPosts
        .map(post => {
            const categoryLabel = CATEGORY_META[post.category]?.label || post.category || '';
            const fields = {
                title: String(post.title || '').toLowerCase(),
                body: String(post.body || '').toLowerCase(),
                hashtags: String(post.hashtags || '').toLowerCase(),
                category: categoryLabel.toLowerCase(),
                author: `${post.user?.full_name || ''} ${post.user?.username || ''} ${post.user?.course || ''}`.toLowerCase()
            };
            let score = fields.title.includes(q) ? 20 : fields.body.includes(q) ? 12 : 0;
            terms.forEach(term => {
                if (fields.title.includes(term)) score += 8;
                if (fields.hashtags.includes(term)) score += 7;
                if (fields.category.includes(term)) score += 7;
                if (fields.body.includes(term)) score += 3;
                if (fields.author.includes(term)) score += 2;
            });
            if (relatedCategories.has(post.category)) score += 4;
            return { post, score };
        })
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score || new Date(b.post.created_at) - new Date(a.post.created_at))
        .map(({ post }) => post);
}

function filterPostsBySearch(query) {
    const container = document.getElementById('postsContainer');
    if (!query) { displayPostsByFilter(currentFilter); return; }

    const filtered = getPostsMatchingSearch(query);

    container.innerHTML = '';
    if (!filtered.length) {
        container.innerHTML = `<p style="text-align:center;color:#636e72;padding:40px;">No posts found for "${escapeHtml(query)}"</p>`;
        return;
    }
    filtered.forEach(post => container.appendChild(createPostElement(post)));
}

function getSearchSuggestionsDropdown() {
    const searchContainer = document.querySelector('.search-container');
    if (!searchContainer) return null;

    let dropdown = searchContainer.querySelector('.search-suggestions-dropdown');
    if (!dropdown) {
        dropdown = document.createElement('div');
        dropdown.className = 'search-suggestions-dropdown hidden';
        dropdown.id = 'search-suggestions';
        dropdown.setAttribute('role', 'listbox');
        dropdown.setAttribute('aria-label', 'Search suggestions');
        searchContainer.appendChild(dropdown);
    }

    const input = searchContainer.querySelector('.search-input');
    if (input) {
        input.setAttribute('aria-controls', dropdown.id);
        input.setAttribute('aria-expanded', String(!dropdown.classList.contains('hidden')));
    }
    return dropdown;
}

function hideSearchSuggestions() {
    const dropdown = getSearchSuggestionsDropdown();
    if (!dropdown) return;
    userSearchRequestToken += 1;
    dropdown.classList.add('hidden');
    dropdown.innerHTML = '';
    const input = document.querySelector('.search-input');
    input?.setAttribute('aria-expanded', 'false');
    input?.removeAttribute('aria-activedescendant');
}

function renderSearchSuggestions(posts, users, queryText) {
    const dropdown = getSearchSuggestionsDropdown();
    if (!dropdown) return;

    if (!queryText) {
        hideSearchSuggestions();
        return;
    }

    const postSuggestions = posts.slice(0, 6).map(post => {
        const title = escapeHtml(post.title || 'Untitled post');
        const category = escapeHtml(CATEGORY_META[post.category]?.label || post.category || 'Wellness');
        const author = escapeHtml(post.user?.full_name || post.user?.username || 'GC FitShare member');
        return `
            <button class="search-post-item" type="button" role="option" aria-selected="false" data-post-id="${escapeHtml(String(post.id || ''))}">
                <svg class="search-suggestion-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m16 16 4 4"></path></svg>
                <span class="search-suggestion-meta">
                    <span class="search-suggestion-title">${title}</span>
                    <span class="search-suggestion-sub">${category} · ${author}</span>
                </span>
                <span class="search-suggestion-kind">Post</span>
            </button>
        `;
    }).join('');

    const userSuggestions = users.map(user => {
        const displayName = user.full_name || user.username || 'GC Student';
        const subtitle = `${user.username ? '@' + user.username : 'gc_student'}${user.course ? ' • ' + user.course : ''}`;
        const expertBadge = user.is_expert && typeof getExpertUserBadgeSvg === 'function'
            ? getExpertUserBadgeSvg(user.id, 18)
            : (user.is_expert ? ' <span class="search-user-expert">Expert</span>' : '');
        const adminBadge = user.is_admin && typeof getAdminUserBadgeHtml === 'function'
            ? getAdminUserBadgeHtml(`s-${user.id}`, 18)
            : (user.is_admin ? ' <span class="search-user-admin">Admin</span>' : '');
        return `
            <button class="search-user-item" type="button" role="option" aria-selected="false" data-user-id="${escapeHtml(String(user.id || ''))}">
                <div class="search-user-avatar">${escapeHtml(displayName.slice(0, 1).toUpperCase())}</div>
                <div class="search-user-meta">
                    <div class="search-user-name search-user-name-row">${escapeHtml(displayName)}${expertBadge}${adminBadge}</div>
                    <div class="search-user-sub">${escapeHtml(subtitle)}</div>
                </div>
                <span class="search-suggestion-kind">Person</span>
            </button>
        `;
    }).join('');

    const groups = [];
    if (postSuggestions) {
        groups.push(`<div class="search-suggestion-group" role="group" aria-label="Matching posts"><div class="search-suggestion-heading">Posts</div>${postSuggestions}</div>`);
    }
    if (userSuggestions) {
        groups.push(`<div class="search-suggestion-group" role="group" aria-label="Matching people"><div class="search-suggestion-heading">People</div>${userSuggestions}</div>`);
    }
    if (!groups.length) {
        groups.push('<div class="search-user-empty">No related posts or people found. Press Enter to search posts.</div>');
    }

    dropdown.innerHTML = groups.join('');
    dropdown.classList.remove('hidden');
    document.querySelector('.search-input')?.setAttribute('aria-expanded', 'true');

    dropdown.querySelectorAll('.search-post-item').forEach(button => {
        button.addEventListener('click', () => {
            const postId = button.getAttribute('data-post-id');
            const post = allPosts.find(item => String(item.id) === postId);
            if (!post) return;
            const input = document.querySelector('.search-input');
            if (input) input.value = post.title || '';
            filterPostsBySearch(post.title || queryText);
            hideSearchSuggestions();
        });
    });

    dropdown.querySelectorAll('.search-user-item').forEach(button => {
        button.addEventListener('click', () => {
            const userId = button.getAttribute('data-user-id');
            if (!userId) return;
            hideSearchSuggestions();
            navigateToUserProfile(userId);
        });
    });
}

function moveSearchSuggestionSelection(direction) {
    const dropdown = getSearchSuggestionsDropdown();
    const suggestions = [...(dropdown?.querySelectorAll('[role="option"]') || [])];
    if (!suggestions.length) return false;

    suggestions.forEach((option, index) => {
        option.id = `search-suggestion-${index}`;
    });
    const activeIndex = suggestions.findIndex(option => option.getAttribute('aria-selected') === 'true');
    const nextIndex = activeIndex === -1
        ? (direction > 0 ? 0 : suggestions.length - 1)
        : (activeIndex + direction + suggestions.length) % suggestions.length;

    suggestions.forEach((option, index) => {
        const isSelected = index === nextIndex;
        option.setAttribute('aria-selected', String(isSelected));
        option.classList.toggle('is-active', isSelected);
    });
    document.querySelector('.search-input')?.setAttribute('aria-activedescendant', suggestions[nextIndex].id);
    return true;
}

function submitFeedSearch() {
    const input = document.querySelector('.search-input');
    if (!input) return;
    filterPostsBySearch(input.value.trim());
    hideSearchSuggestions();
}

async function searchUsers(query) {
    const rawQuery = String(query ?? '').trim();
    const queryText =
        typeof sanitizeUserSearchForOrClause === 'function'
            ? sanitizeUserSearchForOrClause(rawQuery)
            : rawQuery;
    if (!queryText || queryText.length < 2) {
        userSearchRequestToken += 1;
        userSearchResults = [];
        if (searchSuggestionQuery === rawQuery) {
            renderSearchSuggestions(postSearchResults, [], rawQuery);
        }
        return;
    }

    const requestToken = ++userSearchRequestToken;
    try {
        const { data, error } = await supabase
            .from('users')
            .select('id, full_name, username, course, is_expert, is_admin')
            .or(`full_name.ilike.%${queryText}%,username.ilike.%${queryText}%,course.ilike.%${queryText}%`)
            .limit(8);

        if (requestToken !== userSearchRequestToken) return;
        if (error) throw error;

        userSearchResults = data || [];
        const searchAdminSet =
            typeof fetchAdminUserIdsSet === 'function' ? await fetchAdminUserIdsSet(supabase) : new Set();
        if (requestToken !== userSearchRequestToken) return;
        if (typeof mergeIsAdminFlag === 'function') {
            userSearchResults.forEach(user => {
                user.is_admin = mergeIsAdminFlag(user.id, !!user.is_admin, searchAdminSet);
            });
        }
        if (searchSuggestionQuery === rawQuery && !getSearchSuggestionsDropdown()?.classList.contains('hidden')) {
            renderSearchSuggestions(postSearchResults, userSearchResults, rawQuery);
        }
    } catch (err) {
        if (requestToken !== userSearchRequestToken) return;
        console.error('User search error:', err);
        userSearchResults = [];
        if (searchSuggestionQuery === rawQuery && !getSearchSuggestionsDropdown()?.classList.contains('hidden')) {
            renderSearchSuggestions(postSearchResults, [], rawQuery);
        }
    }
}

// ─── Trending Sidebar ────────────────────────────────────────────────────────
async function loadTrendingPosts() {
    const container = document.getElementById('trendingPosts');
    try {
        const trending = [...allPosts]
            .sort((a, b) =>
                ((b.upvotes_count||0) + (b.comments_count||0)) -
                ((a.upvotes_count||0) + (a.comments_count||0))
            )
            .slice(0, 8);

        container.innerHTML = trending.map(post => `
            <div class="trending-post-item" onclick="scrollToPost('${post.id}')">
                <div class="trending-post-title">${escapeHtml(post.title || '')}</div>
                <div class="trending-post-stats">
                    <span>▲ ${post.upvotes_count || 0}</span>
                    <span>${post.comments_count || 0} comments</span>
                </div>
            </div>
        `).join('');
    } catch (e) {
        container.innerHTML = '<p style="color:#636e72;font-size:12px;text-align:center;">No trending posts yet</p>';
    }
}

// ─── Create Post Card ─────────────────────────────────────────────────────────
const CATEGORY_META = {
    nutrition:        { label: 'Nutrition',        color: '#FF6B6B' },
    fitness:          { label: 'Fitness',           color: '#4ECDC4' },
    mental_wellness:  { label: 'Mental Wellness',  color: '#95E1D3' },
    productivity:     { label: 'Productivity',      color: '#FFE66D' }
};

function getCategoryBadge(categoryId) {
    const cat = CATEGORY_META[categoryId];
    if (!cat) return '';
    return `<span class="category-badge" style="background:${cat.color}20;color:${cat.color};border:1px solid ${cat.color}40;">${cat.label}</span>`;
}

function buildPostAvatarHtml(user, initials) {
    const raw = user?.avatar_url ? String(user.avatar_url).trim() : '';
    let url = raw;
    if (raw && !/^https?:\/\//i.test(raw)) {
        const storagePrefix = /^\/?storage\/v1\/object\/public\/profile-pictures\//i;
        if (storagePrefix.test(raw)) {
            url = `${SUPABASE_URL}/storage/v1/object/public/profile-pictures/${encodeURI(raw.replace(storagePrefix, ''))}`;
        } else {
            const path = raw.replace(/^profile-pictures\//i, '');
            url = path.startsWith('profiles/')
                ? supabase?.storage?.from('profile-pictures').getPublicUrl(path)?.data?.publicUrl || ''
                : '';
        }
    }
    if (url) {
        return `<img class="post-avatar post-avatar-img" src="${escapeHtml(url)}" alt="" width="45" height="45" loading="lazy" referrerpolicy="no-referrer">`;
    }
    return `<div class="post-avatar post-avatar-fallback">${initials}</div>`;
}

function createPostElement(post) {
    const {
        id, user, title, body, image_url,
        hashtags: postHashtags, created_at, category,
        upvotes_count = 0, downvotes_count = 0, comments_count = 0
    } = post;

    const displayName = user?.full_name || user?.username || 'GC Student';
    const course      = user?.course    || '';
    const isExpert = !!(user?.is_expert) || (post.user_id === currentUser?.id && currentUserIsExpert);
    const isAdminUser = !!(user?.is_admin) || (post.user_id === currentUser?.id && currentUserIsAdmin);
    const initials    = displayName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || 'GC';
    const isOwnPost   = post.user_id === currentUser?.id;
    const expertLim = typeof getExpertWeeklyEndorsementLimit === 'function' ? getExpertWeeklyEndorsementLimit() : 3;
    const expertUserBadge = isExpert && typeof getExpertUserBadgeSvg === 'function'
        ? getExpertUserBadgeSvg(id)
        : (isExpert ? '<span class="expert-badge-fallback">Expert</span>' : '');
    const adminUserBadge = isAdminUser && typeof getAdminUserBadgeHtml === 'function'
        ? getAdminUserBadgeHtml(`p-${id}`)
        : (isAdminUser ? '<span class="admin-badge-fallback">Admin</span>' : '');
    const postHasExpertBadge =
        !!(post.expert_endorsed_at || post.is_expert_approved);
    const expertApprovedStrip =
        postHasExpertBadge && typeof getPostExpertApprovedBadgeHtml === 'function'
            ? getPostExpertApprovedBadgeHtml(id)
            : '';
    const showExpertEndorseActive =
        currentUserIsExpert && !isOwnPost && !postHasExpertBadge && expertWeeklyRemaining > 0;
    const showExpertEndorseDisabled =
        currentUserIsExpert && !isOwnPost && !postHasExpertBadge && expertWeeklyRemaining <= 0;
    const expertEndorseMenuActive = showExpertEndorseActive
        ? `<button type="button" class="menu-item expert-endorse-btn" data-post-id="${id}">Expert approve (${expertWeeklyRemaining}/${expertLim} this week)</button>`
        : '';
    const expertEndorseMenuDisabled = showExpertEndorseDisabled
        ? `<button type="button" class="menu-item expert-endorse-disabled" disabled>Expert approve (0/${expertLim} — resets Monday)</button>`
        : '';
    const canRemoveExpertBadge =
        currentUserIsExpert && postHasExpertBadge && post.expert_endorsed_by === currentUser?.id;
    const expertRemoveBadgeMenu = canRemoveExpertBadge
        ? `<button type="button" class="menu-item expert-remove-badge-btn" data-post-id="${id}">Remove expert badge</button>`
        : '';

    const reportMenuItem = isOwnPost
        ? ''
        : `<button class="menu-item report-btn" data-post-id="${id}">Report</button>`;

    const hashtagsHTML = postHashtags
        ? (typeof postHashtags === 'string' ? postHashtags.split(' ') : postHashtags)
            .filter(Boolean)
            .map(tag => `<span class="hashtag">${escapeHtml(tag)}</span>`)
            .join('')
        : '';

    // FIX: use body not content
    const bodyPreview = body ? body.substring(0, 300) : '';
    const hasMore     = body && body.length > 300;

    // ── date string ──
    const dateStr = created_at
        ? new Date(created_at).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit'
          })
        : 'Just now';

    const el = document.createElement('div');
    el.className     = 'post-card';
    el.dataset.postId = id;
    el.style.cursor = 'pointer';

    el.innerHTML = `
        <div class="post-header">
            <button class="post-author-info author-link-btn" data-user-id="${post.user_id}" title="View profile">
                ${buildPostAvatarHtml(user, initials)}
                <div class="post-author-details">
                    <div class="post-author-name">
                        ${escapeHtml(displayName)}
                        ${expertUserBadge}
                        ${adminUserBadge}
                    </div>
                    <div class="post-author-course">${escapeHtml(course)}</div>
                </div>
            </button>
            <div class="post-header-actions">
                <div class="post-date">${dateStr}</div>
                <div class="post-menu">
                    <button class="post-action-btn menu-toggle" title="More options">⋯</button>
                    <div class="menu-dropdown">
                        <button class="menu-item share-btn" data-post-id="${id}">Share</button>
                        ${reportMenuItem}
                        ${expertEndorseMenuActive}
                        ${expertEndorseMenuDisabled}
                        ${expertRemoveBadgeMenu}
                        ${isOwnPost ? `<button class="menu-item delete-btn" data-post-id="${id}" style="color:#e74c3c;">Delete Post</button>` : ''}
                    </div>
                </div>
            </div>
        </div>

        ${category ? `<div class="post-category">${getCategoryBadge(category)}</div>` : ''}
        ${expertApprovedStrip}
        <h3 class="post-title">${escapeHtml(title || '')}</h3>
        ${image_url ? `<img src="${image_url}" alt="Post image" class="post-image">` : ''}
        ${bodyPreview ? `<p class="post-body">${formatMarkdown(bodyPreview)}${hasMore ? '<span class="post-truncation">...</span>' : ''}</p>` : ''}
        ${hasMore ? '<button class="read-more-btn" type="button" data-expanded="false">Read more</button>' : ''}
        ${hashtagsHTML ? `<div class="post-hashtags">${hashtagsHTML}</div>` : ''}

        <div class="post-footer">
            <div class="post-voting">
                <button class="vote-btn upvote-btn" data-post-id="${id}" title="Upvote">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                        <polyline points="18 15 12 9 6 15"></polyline>
                    </svg>
                    <span class="upvote-count">${upvotes_count}</span>
                </button>
                <button class="vote-btn downvote-btn" data-post-id="${id}" title="Downvote">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                        <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                    <span class="downvote-count">${downvotes_count}</span>
                </button>
            </div>
            <div class="post-right-actions">
                <button class="post-action-btn comment-btn" data-post-id="${id}" title="Comment">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                    </svg>
                    <span class="comment-count">${comments_count}</span>
                </button>
                <button class="post-action-btn bookmark-btn" data-post-id="${id}" title="Bookmark">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
                    </svg>
                </button>
            </div>
            
        </div>
    `;

    // attach events
    el.querySelector('.upvote-btn').addEventListener('click',   () => upvotePost(id, el));
    el.querySelector('.downvote-btn').addEventListener('click', () => downvotePost(id, el));
    el.querySelector('.comment-btn').addEventListener('click',  () => openCommentThread(id, post));
    el.querySelector('.menu-toggle').addEventListener('click',  (e) => togglePostMenu(e));
    el.querySelector('.report-btn')?.addEventListener('click', (e) => openReportModal(e, id));
    el.querySelector('.share-btn').addEventListener('click',    (e) => sharePost(e, id, post));
    el.querySelector('.bookmark-btn').addEventListener('click', () => toggleBookmark(id, el));
    el.querySelector('.author-link-btn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        navigateToUserProfile(post.user_id);
    });
    const delBtn = el.querySelector('.delete-btn');
    if (delBtn) delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteMyPost(id); });

    const exBtn = el.querySelector('.expert-endorse-btn');
    if (exBtn) {
        exBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            el.querySelector('.menu-dropdown')?.classList.remove('active');
            if (typeof tryExpertEndorsePost !== 'function') return;
            exBtn.disabled = true;
            const result = await tryExpertEndorsePost(supabase, {
                expertUserId: currentUser.id,
                postId: id,
                postOwnerId: post.user_id
            });
            exBtn.disabled = false;
            if (!result.ok) {
                if (typeof CustomAlert !== 'undefined' && CustomAlert.show) {
                    CustomAlert.show('Expert approve', result.error || 'Something went wrong.', 'error');
                } else {
                    console.warn(result.error);
                }
                return;
            }
            expertWeeklyRemaining = result.weeklyRemaining ?? expertWeeklyRemaining;
            post.expert_endorsed_at = new Date().toISOString();
            post.is_expert_approved = true;
            if (typeof getPostExpertApprovedBadgeHtml === 'function') {
                const wrap = document.createElement('div');
                wrap.innerHTML = getPostExpertApprovedBadgeHtml(id);
                const strip = wrap.firstElementChild;
                const catEl = el.querySelector('.post-category');
                const titleEl = el.querySelector('.post-title');
                if (catEl && strip) catEl.after(strip);
                else if (titleEl && strip) titleEl.before(strip);
                else if (strip) el.querySelector('.post-header')?.after(strip);
            }
            exBtn.remove();
            el.querySelector('.expert-endorse-disabled')?.remove();
            const lim = typeof getExpertWeeklyEndorsementLimit === 'function' ? getExpertWeeklyEndorsementLimit() : 3;
            document.querySelectorAll('.expert-endorse-btn').forEach((btn) => {
                if (expertWeeklyRemaining < 1) {
                    const dis = document.createElement('button');
                    dis.type = 'button';
                    dis.className = 'menu-item expert-endorse-disabled';
                    dis.disabled = true;
                    dis.textContent = `Expert approve (0/${lim} — resets Monday)`;
                    btn.replaceWith(dis);
                } else {
                    btn.textContent = `Expert approve (${expertWeeklyRemaining}/${lim} this week)`;
                }
            });
            if (typeof CustomAlert !== 'undefined' && CustomAlert.show) {
                CustomAlert.show('Thank you', 'Expert approval saved for this post.', 'success');
            }
        });
    }

    const rmBadgeBtn = el.querySelector('.expert-remove-badge-btn');
    if (rmBadgeBtn) {
        rmBadgeBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            el.querySelector('.menu-dropdown')?.classList.remove('active');
            if (typeof tryExpertRemovePostBadge !== 'function') return;
            const proceed = typeof CustomAlert !== 'undefined' && CustomAlert.confirm
                ? await CustomAlert.confirm('Remove badge', 'Remove your Expert approved badge from this post?', { confirmText: 'Remove', cancelText: 'Cancel', danger: true })
                : confirm('Remove your Expert approved badge from this post?');
            if (!proceed) return;
            rmBadgeBtn.disabled = true;
            const result = await tryExpertRemovePostBadge(supabase, {
                expertUserId: currentUser.id,
                postId: id
            });
            rmBadgeBtn.disabled = false;
            if (!result.ok) {
                if (typeof CustomAlert !== 'undefined' && CustomAlert.show) {
                    CustomAlert.show('Remove badge', result.error || 'Something went wrong.', 'error');
                }
                return;
            }
            post.expert_endorsed_at = null;
            post.expert_endorsed_by = null;
            post.is_expert_approved = false;
            el.querySelector('.post-expert-endorsed-strip')?.remove();
            rmBadgeBtn.remove();
            if (typeof CustomAlert !== 'undefined' && CustomAlert.show) {
                CustomAlert.show('Badge removed', result.warning || 'The Expert approved badge was removed from this post.', 'success');
            }
        });
    }

    // ── read more (opens full post modal - Reddit style) ────────────────────
    const readMoreBtn = el.querySelector('.read-more-btn');
    if (readMoreBtn) {
        readMoreBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            openFullPostModal(id, title, body, displayName, course, created_at, image_url, category);
        });
    }

    // Make entire post card clickable (except interactive elements) to open modal
    el.addEventListener('click', (e) => {
        const target = e.target;
        const isInteractive = target.closest('button') || 
                             target.closest('a') || 
                             target.closest('input') || 
                             target.closest('textarea') ||
                             target.closest('.post-actions') ||
                             target.closest('.comment-section') ||
                             target.closest('.menu-dropdown') ||
                             target.closest('.read-more-btn');
        if (!isInteractive) {
            openFullPostModal(id, title, body, displayName, course, created_at, image_url, category);
        }
    });

    el.style.cursor = 'pointer';

    return el;
}

// ─── Bookmarks ────────────────────────────────────────────────────────────────
async function toggleBookmark(postId, cardEl) {
    const btn = cardEl.querySelector('.bookmark-btn svg');
    try {
        const { data: existing } = await supabase
            .from('bookmarks')
            .select('id')
            .eq('user_id', currentUser.id)
            .eq('post_id', postId)
            .single();

        if (existing) {
            await supabase.from('bookmarks').delete().eq('id', existing.id);
            btn.setAttribute('fill', 'none');
            cardEl.querySelector('.bookmark-btn').classList.remove('bookmarked');
        } else {
            await supabase.from('bookmarks').insert({
                user_id: currentUser.id,
                post_id: postId
            });
            btn.setAttribute('fill', 'currentColor');
            cardEl.querySelector('.bookmark-btn').classList.add('bookmarked');
        }
    } catch (err) {
        console.error('Bookmark error:', err);
    }
}

async function markSavedBookmarks() {
    try {
        const { data: bookmarks } = await supabase
            .from('bookmarks')
            .select('post_id')
            .eq('user_id', currentUser.id);

        if (!bookmarks) return;
        bookmarks.forEach(b => {
            const card = document.querySelector(`[data-post-id="${b.post_id}"]`);
            if (card) {
                card.querySelector('.bookmark-btn')?.classList.add('bookmarked');
                const svg = card.querySelector('.bookmark-btn svg');
                if (svg) svg.setAttribute('fill', 'currentColor');
            }
        });
    } catch (err) {
        console.error('markSavedBookmarks error:', err);
    }
}

// ─── Voting (FIX: defined here, use 'up'/'down') ─────────────────────────────
async function upvotePost(postId, cardEl) {
    try {
        let shouldNotifyPostLike = false;
        // check if already voted
        const { data: existing } = await supabase
            .from('votes')
            .select('id, vote_type')
            .eq('post_id', postId)
            .eq('user_id', currentUser.id)
            .single();

        if (existing) {
            if (existing.vote_type === 'up') {
                // undo upvote
                await supabase.from('votes').delete().eq('id', existing.id);
            } else {
                // switch from down to up
                await supabase.from('votes').update({ vote_type: 'up' }).eq('id', existing.id);
                shouldNotifyPostLike = true;
            }
        } else {
            await supabase.from('votes').insert({
                post_id:    postId,
                user_id:    currentUser.id,
                vote_type:  'up'
            });
            shouldNotifyPostLike = true;
        }
        // refresh just this card's counts
        await refreshVoteCounts(postId, cardEl);
        if (shouldNotifyPostLike) {
            await createPostLikeNotification(postId);
        }
    } catch (err) {
        console.error('Upvote error:', err);
    }
}

async function downvotePost(postId, cardEl) {
    try {
        const { data: existing } = await supabase
            .from('votes')
            .select('id, vote_type')
            .eq('post_id', postId)
            .eq('user_id', currentUser.id)
            .single();

        if (existing) {
            if (existing.vote_type === 'down') {
                await supabase.from('votes').delete().eq('id', existing.id);
            } else {
                await supabase.from('votes').update({ vote_type: 'down' }).eq('id', existing.id);
            }
        } else {
            await supabase.from('votes').insert({
                post_id:   postId,
                user_id:   currentUser.id,
                vote_type: 'down'
            });
        }
        await refreshVoteCounts(postId, cardEl);
    } catch (err) {
        console.error('Downvote error:', err);
    }
}

async function refreshVoteCounts(postId, cardEl) {
    const { count: up }   = await supabase.from('votes').select('*', { count: 'exact', head: true }).eq('post_id', postId).eq('vote_type', 'up');
    const { count: down } = await supabase.from('votes').select('*', { count: 'exact', head: true }).eq('post_id', postId).eq('vote_type', 'down');
    cardEl.querySelector('.upvote-count').textContent   = up   || 0;
    cardEl.querySelector('.downvote-count').textContent = down || 0;

    // also update allPosts cache
    const p = allPosts.find(p => p.id === postId);
    if (p) { p.upvotes_count = up || 0; p.downvotes_count = down || 0; }
}

async function createPostLikeNotification(postId) {
    try {
        if (!currentUser?.id || !postId) return;

        const cachedPost = allPosts.find(p => p.id === postId);
        let targetUserId = cachedPost?.user_id || null;
        let postTitle = (cachedPost?.title || '').trim();

        if (!targetUserId) {
            const { data: postRow } = await supabase
                .from('posts')
                .select('user_id, title')
                .eq('id', postId)
                .maybeSingle();
            targetUserId = postRow?.user_id || null;
            if (!postTitle) postTitle = (postRow?.title || '').trim();
        }

        if (!targetUserId || targetUserId === currentUser.id) return;

        let actorName = currentUser?.user_metadata?.full_name || '';
        if (!actorName) {
            const { data: actorRow } = await supabase
                .from('users')
                .select('full_name, username, email')
                .eq('id', currentUser.id)
                .maybeSingle();
            actorName = actorRow?.full_name || actorRow?.username || actorRow?.email?.split('@')?.[0] || 'Someone';
        }

        const titlePreview = postTitle ? ` "${postTitle.substring(0, 60)}${postTitle.length > 60 ? '...' : ''}"` : '';

        const row = {
            user_id: targetUserId,
            actor_id: currentUser.id,
            type: 'post_like',
            title: 'New like on your post',
            message: `${actorName} liked your post${titlePreview}.`,
            is_read: false,
            post_id: postId
        };
        const { error } =
            typeof insertPostLikeNotificationDeduped === 'function'
                ? await insertPostLikeNotificationDeduped(supabase, row)
                : typeof insertNotificationRow === 'function'
                  ? await insertNotificationRow(supabase, row)
                  : await supabase.from('notifications').insert(row);
        if (error) throw error;
    } catch (err) {
        // Keep upvote action successful even if notifications setup is missing.
        console.warn('Post like notification insert skipped:', err?.message || err);
    }
}

// ─── Comments ────────────────────────────────────────────────────────────────
function setCommentReplyTarget(postId, commentId, authorName) {
    const modal = document.getElementById(`comments-modal-${postId}`);
    if (!modal) return;
    modal.dataset.replyParentId = commentId || '';
    const tag = (authorName || 'User').trim().replace(/\s+/g, ' ');
    modal.dataset.replyAuthorTag = commentId ? tag : '';
    const hint = document.getElementById(`comment-reply-hint-${postId}`);
    if (hint) {
        if (commentId) {
            hint.innerHTML = `Replying to <strong>${escapeHtml(authorName || 'User')}</strong> · <button type="button" class="comment-reply-cancel-btn">Cancel</button>`;
            hint.style.display = 'block';
        } else {
            hint.innerHTML = '';
            hint.style.display = 'none';
        }
    }
    document.getElementById(`comment-input-${postId}`)?.focus();
}

async function openCommentThread(postId, post, opts = {}) {
    const forceReplace = !!opts.forceReplace;
    const existing = document.getElementById(`comments-modal-${postId}`);
    if (existing) {
        existing.remove();
        if (!forceReplace) return;
    }

    const modal = document.createElement('div');
    modal.className = 'modal modal-comments-host';
    modal.id = `comments-modal-${postId}`;
    modal.innerHTML = `
        <div class="modal-content comments-modal" style="max-width:600px;">
            <div class="modal-header">
                <h2>Comments</h2>
                <button class="modal-close" onclick="this.closest('.modal').remove()">&times;</button>
            </div>
            <div class="modal-body">
                <div class="post-preview">
                    <strong>${escapeHtml(post.title || '')}</strong>
                    ${post.body ? `<p>${escapeHtml(post.body.substring(0, 100))}</p>` : ''}
                </div>
                <div class="comment-reply-hint" id="comment-reply-hint-${postId}" style="display:none;"></div>
                <div class="comment-form">
                    <input type="text" class="comment-input" id="comment-input-${postId}"
                        placeholder="Write a comment or reply…" maxlength="500">
                    <button class="btn-primary" onclick="submitComment('${postId}', this)">Post</button>
                </div>
                <div class="comments-list" id="comments-list-${postId}">
                    <p style="text-align:center;color:#636e72;">Loading comments...</p>
                </div>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal.style.display = 'flex';

    if (currentUser?.id && typeof checkPostingAllowed === 'function') {
        const postingCheck = await checkPostingAllowed(supabase, currentUser.id);
        if (!postingCheck.allowed) {
            const msg =
                postingCheck.message ||
                'Your account cannot post comments right now.';
            const inputEl = modal.querySelector(`#comment-input-${postId}`);
            const postBtn = modal.querySelector('.comment-form .btn-primary');
            if (inputEl) {
                inputEl.disabled = true;
                inputEl.placeholder = 'Comments disabled while your account is restricted.';
            }
            if (postBtn) {
                postBtn.disabled = true;
                postBtn.textContent = 'Restricted';
            }
            const note = document.createElement('p');
            note.className = 'comment-posting-blocked-note';
            note.style.cssText =
                'color:#f39c12;font-size:13px;margin:0 0 10px 0;line-height:1.45;padding:8px 10px;border-radius:8px;background:rgba(243,156,18,0.12);';
            note.textContent = `${msg} You can still read comments below.`;
            modal.querySelector('.comment-form')?.insertAdjacentElement('afterbegin', note);
        }
    }

    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
        if (e.target.closest('.comment-reply-cancel-btn')) {
            e.preventDefault();
            setCommentReplyTarget(postId, '', '');
        }
        const moreRepliesBtn = e.target.closest('.btn-show-more-replies');
        if (moreRepliesBtn) {
            e.preventDefault();
            const tid = moreRepliesBtn.getAttribute('data-replies-extra');
            const box = tid ? document.getElementById(tid) : null;
            const cnt = parseInt(moreRepliesBtn.getAttribute('data-hidden-count') || '0', 10) || 0;
            if (!box) return;
            const expanded = moreRepliesBtn.getAttribute('aria-expanded') === 'true';
            if (expanded) {
                box.hidden = true;
                moreRepliesBtn.setAttribute('aria-expanded', 'false');
                moreRepliesBtn.textContent = `See ${cnt} more ${cnt === 1 ? 'reply' : 'replies'}`;
            } else {
                box.hidden = false;
                moreRepliesBtn.setAttribute('aria-expanded', 'true');
                moreRepliesBtn.textContent = 'Show fewer replies';
            }
            return;
        }
        const replyBtn = e.target.closest('.btn-reply');
        if (replyBtn) {
            e.preventDefault();
            setCommentReplyTarget(
                postId,
                replyBtn.getAttribute('data-comment-id'),
                replyBtn.getAttribute('data-author-name') || ''
            );
        }
    });
    await loadComments(postId);
}

const COMMENT_REPLY_PREVIEW_LIMIT = 3;

function escapeMentionRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Highlights @mentions after escaping (safe).
 * A reply's leading @Name is highlighted in full. Every other @mention is a single
 * username token, so the reply text that follows (for example "Hi") stays unstyled.
 */
function formatCommentBodyDisplay(raw, mentionName) {
    let formatted = escapeHtml(raw || '');
    const name = String(mentionName || '').trim().replace(/\s+/g, ' ');
    if (name) {
        const escapedName = escapeHtml(name);
        const replyMention = new RegExp(
            `^@${escapeMentionRegExp(escapedName)}(?=$|[\\s]|[.,!?;:])`,
            'i'
        );
        formatted = formatted.replace(
            replyMention,
            (match) => `<span class="comment-mention">${match}</span>`
        );
    }
    formatted = formatted.replace(
        /(^|[\s])@([^\s@<>.,!?;:]+)(?=$|[\s]|[.,!?;:])/g,
        (full, lead, mention, offset, str) => {
            const before = str.slice(0, offset);
            const opens = (before.match(/<span class="comment-mention">/g) || []).length;
            const closes = (before.match(/<\/span>/g) || []).length;
            if (opens > closes) return full;
            return `${lead}<span class="comment-mention">@${mention}</span>`;
        }
    );
    // Apply basic markdown formatting
    formatted = formatted
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/__([^_]+)__/g, '<u>$1</u>');
    return formatted;
}

function buildCommentTreeHtml(comments, postId) {
    const byId = new Map((comments || []).map((c) => [c.id, c]));
    const byParent = new Map();
    comments.forEach((c) => {
        const pid = c.parent_comment_id || '__root__';
        if (!byParent.has(pid)) byParent.set(pid, []);
        byParent.get(pid).push(c);
    });
    byParent.forEach((arr) => {
        arr.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    });

    const roots = byParent.get('__root__') || [];

    function renderChildReplyBlocks(parentCommentId, kids, depth) {
        if (!kids.length) return '';
        const head = kids.slice(0, COMMENT_REPLY_PREVIEW_LIMIT);
        const tail = kids.slice(COMMENT_REPLY_PREVIEW_LIMIT);
        const extraId = `replies-extra-${parentCommentId}`;
        const headHtml = head.map((k) => renderNode(k, depth)).join('');
        const tailHtml = tail.length
            ? `<button type="button" class="btn-show-more-replies" data-replies-extra="${extraId}" data-hidden-count="${tail.length}" aria-expanded="false">See ${tail.length} more ${tail.length === 1 ? 'reply' : 'replies'}</button>
                <div class="comment-replies-extra" id="${extraId}" hidden>${tail.map((k) => renderNode(k, depth)).join('')}</div>`
            : '';
        return `<div class="comment-replies-cluster" data-nesting-depth="${depth}">
            ${headHtml}
            ${tailHtml}
        </div>`;
    }

    function renderNode(c, depth) {
        const authorName = c.user?.full_name || c.user?.username || 'GC Student';
        const safeAuthor = escapeHtml(authorName);
        const attrAuthor = escapeHtml(authorName);
        const commentAuthorExpert =
            !!(c.user?.is_expert) ||
            (c.user_id === currentUser?.id && currentUserIsExpert);
        const commentAuthorAdmin =
            !!(c.user?.is_admin) ||
            (c.user_id === currentUser?.id && currentUserIsAdmin);
        const commentExpertBadge =
            commentAuthorExpert && typeof getExpertUserBadgeSvg === 'function'
                ? getExpertUserBadgeSvg(`${postId}-${c.id}`)
                : commentAuthorExpert
                  ? '<span class="expert-badge-fallback">Expert</span>'
                  : '';
        const commentAdminBadge =
            commentAuthorAdmin && typeof getAdminUserBadgeHtml === 'function'
                ? getAdminUserBadgeHtml(`c-${postId}-${c.id}`)
                : commentAuthorAdmin
                  ? '<span class="admin-badge-fallback">Admin</span>'
                  : '';
        const parent = c.parent_comment_id ? byId.get(c.parent_comment_id) : null;
        const parentAuthor = parent
            ? parent.user?.full_name || parent.user?.username || 'User'
            : '';
        const replyToLine = parent
            ? `<div class="comment-reply-to">Replying to <strong>${escapeHtml(parentAuthor)}</strong></div>`
            : '';
        const kids = byParent.get(c.id) || [];
        const replyBtn = currentUser
            ? `<button type="button" class="btn-reply" data-comment-id="${c.id}" data-author-name="${attrAuthor}">Reply</button>`
            : '';
        const nested = kids.length ? renderChildReplyBlocks(c.id, kids, depth + 1) : '';
        const depthCls = `comment-depth-${Math.min(depth, 8)}`;
        return `
            <div class="comment-thread ${depth > 0 ? 'comment-thread--nested' : ''} ${depthCls}" data-comment-id="${c.id}" style="--thread-depth:${depth}">
                ${replyToLine}
                <div class="comment-header">
                    <strong>${safeAuthor}</strong>
                    ${commentExpertBadge}
                    ${commentAdminBadge}
                    <small>${formatDate(c.created_at)}</small>
                </div>
                <p class="comment-text">${formatCommentBodyDisplay(c.body, parentAuthor)}</p>
                <div class="comment-actions">${replyBtn}</div>
                ${nested}
            </div>`;
    }

    return roots.map((c) => renderNode(c, 0)).join('');
}

async function loadComments(postId) {
    try {
        const { data: comments, error } = await supabase
            .from('comments')
            .select('*, user:user_id(full_name, username, is_expert, is_admin)')
            .eq('post_id', postId)
            .eq('is_deleted', false)
            .order('created_at', { ascending: true });

        if (error) throw error;

        const adminIdSet =
            typeof fetchAdminUserIdsSet === 'function' ? await fetchAdminUserIdsSet(supabase) : new Set();
        if (typeof mergeIsAdminFlag === 'function') {
            (comments || []).forEach((c) => {
                if (!c.user) return;
                c.user.is_admin = mergeIsAdminFlag(c.user_id, !!c.user.is_admin, adminIdSet);
            });
        }

        const container = document.getElementById(`comments-list-${postId}`);
        if (!comments || !comments.length) {
            container.innerHTML = '<p style="text-align:center;color:#636e72;">No comments yet. Be the first!</p>';
            return;
        }

        container.innerHTML = buildCommentTreeHtml(comments, postId);
    } catch (err) {
        console.error('Error loading comments:', err);
        const container = document.getElementById(`comments-list-${postId}`);
        if (container) container.innerHTML = '<p style="color:red;">Error loading comments</p>';
    }
}

async function tryNotifyCommentReplyRecipient(postId, parentCommentId, newCommentId) {
    if (!parentCommentId || !currentUser || !postId) return;
    try {
        const { data: parent, error } = await supabase
            .from('comments')
            .select('user_id')
            .eq('id', parentCommentId)
            .maybeSingle();
        if (error || !parent?.user_id || parent.user_id === currentUser.id) return;

        let actorName = currentUser?.user_metadata?.full_name || '';
        if (!actorName) {
            const { data: actorRow } = await supabase
                .from('users')
                .select('full_name, username, email')
                .eq('id', currentUser.id)
                .maybeSingle();
            actorName = actorRow?.full_name || actorRow?.username || actorRow?.email?.split('@')?.[0] || 'Someone';
        }

        const row = {
            user_id: parent.user_id,
            actor_id: currentUser.id,
            type: 'comment_reply',
            title: 'New reply to your comment',
            message: `${actorName} replied to you in a comment thread. Open it to view.`,
            is_read: false,
            post_id: postId,
            comment_id: newCommentId || null
        };
        const { error: nErr } = typeof insertNotificationRow === 'function'
            ? await insertNotificationRow(supabase, row)
            : await supabase.from('notifications').insert(row);
        if (nErr) throw nErr;
    } catch (err) {
        console.warn('Comment reply notification skipped:', err?.message || err);
    }
}

async function submitComment(postId, button) {
    if (!currentUser?.id) return;
    if (typeof checkPostingAllowed === 'function') {
        const postingCheck = await checkPostingAllowed(supabase, currentUser.id);
        if (!postingCheck.allowed) {
            const msg =
                postingCheck.message ||
                'Your account cannot post comments right now.';
            if (typeof CustomAlert !== 'undefined' && CustomAlert.show) {
                CustomAlert.show(
                    'Comments restricted',
                    `${msg}\n\nThis applies to new comments and replies while your account is restricted.`,
                    'warning'
                );
            } else {
                window.alert(msg);
            }
            return;
        }
    }

    const modal = document.getElementById(`comments-modal-${postId}`);
    const parentId = (modal?.dataset?.replyParentId || '').trim() || null;
    const replyTag = (modal?.dataset?.replyAuthorTag || '').trim();

    const input = document.getElementById(`comment-input-${postId}`);
    let content = input.value.trim();
    if (!content) { CustomAlert.show('Oops!', 'Please write a comment'); return; }

    if (parentId && replyTag) {
        const prefix = `@${replyTag} `;
        const lower = content.toLowerCase();
        const pLower = prefix.trim().toLowerCase();
        if (!lower.startsWith(pLower) && !lower.startsWith(`@${replyTag.toLowerCase()}`)) {
            content = prefix + content;
        }
    }

    button.disabled     = true;
    button.textContent  = 'Posting...';

    try {
        if (typeof analyzeContentWithGemini === 'function') {
            button.textContent = 'Scanning…';
            const moderationResult = await analyzeContentWithGemini('', content, [], { contentType: 'comment' });
            if (!moderationResult.approved) {
                const flags = Array.isArray(moderationResult.flags) ? moderationResult.flags : [];
                const scannerDown =
                    flags.includes('ai_unavailable') ||
                    flags.includes('moderation_request_error') ||
                    moderationResult.source === 'edge-function-fallback' ||
                    moderationResult.source === 'fallback' ||
                    moderationResult.source === 'edge-function-error';
                if (scannerDown) {
                    CustomAlert.show(
                        'Moderation temporarily unavailable',
                        'We could not scan your comment right now. Please try again in a few minutes.'
                    );
                } else {
                    CustomAlert.show(
                        'Comment blocked',
                        moderationResult.reason || 'This comment does not meet community guidelines.'
                    );
                }
                button.disabled = false;
                button.textContent = 'Post';
                return;
            }
        }

        button.textContent = 'Posting...';
        let payload = { post_id: postId, user_id: currentUser.id, body: content };
        if (parentId) payload.parent_comment_id = parentId;

        let { data: inserted, error } = await supabase.from('comments').insert(payload).select('id').maybeSingle();

        if (error && parentId && /parent_comment_id/i.test(error.message || '')) {
            delete payload.parent_comment_id;
            ({ data: inserted, error } = await supabase.from('comments').insert(payload).select('id').maybeSingle());
            console.warn('Add parent_comment_id to comments (see SQL/006_comments_parent_id.sql) for threaded replies.');
        }

        if (error) throw error;

        const newCommentId = inserted?.id || null;

        setCommentReplyTarget(postId, '', '');
        if (modal) modal.dataset.replyAuthorTag = '';
        input.value = '';
        await loadComments(postId);

        if (parentId) {
            await tryNotifyCommentReplyRecipient(postId, parentId, newCommentId);
        }

        // update comment count on card
        const cardEl = document.querySelector(`[data-post-id="${postId}"]`);
        if (cardEl) {
            const span = cardEl.querySelector('.comment-count');
            if (span) span.textContent = parseInt(span.textContent || 0) + 1;
        }
        const p = allPosts.find(p => p.id === postId);
        if (p) p.comments_count = (p.comments_count || 0) + 1;

    } catch (err) {
        console.error('Comment error:', err);
        CustomAlert.show('Error', 'Failed to post your comment. Please try again.');
    } finally {
        button.disabled    = false;
        button.textContent = 'Post';
    }
}

// ─── Report ──────────────────────────────────────────────────────────────────
function openReportModal(e, postId) {
    e.preventDefault();
    const post = allPosts.find((p) => p.id === postId);
    if (post?.user_id === currentUser?.id) {
        CustomAlert.show('Report', 'You cannot report your own post.');
        return;
    }
    currentPostIdToReport = postId;
    document.getElementById('reportPostModal').classList.remove('hidden');
}

function closeReportModal() {
    document.getElementById('reportPostModal')?.classList.add('hidden');
    const reasonEl = document.getElementById('reportReason');
    const detailsEl = document.getElementById('reportDetails');
    if (reasonEl) reasonEl.value = '';
    if (detailsEl) detailsEl.value = '';
    currentPostIdToReport = null;
}

function formatMarkdown(text) {
    if (!text) return '';
    
    try {
        let html = escapeHtml(text);
        
        // Bold: **text**
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        
        // Italic: *text*
        html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        
        // Underline: __text__
        html = html.replace(/__([^_]+)__/g, '<u>$1</u>');
        
        // Line breaks
        html = html.replace(/\n/g, '<br>');
        
        return html;
    } catch (err) {
        return escapeHtml(text);
    }
}

function openFullPostModal(postId, title, body, authorName, authorCourse, createdAt, imageUrl, category) {
    const modal = document.getElementById('fullPostModal');
    const contentEl = document.getElementById('fullPostContent');
    const sourcePost = allPosts.find((post) => post.id === postId);
    const displayName = authorName || sourcePost?.user?.full_name || sourcePost?.user?.username || 'Anonymous';
    const initials = displayName.split(' ').map((name) => name[0]).join('').toUpperCase().slice(0, 2) || 'GC';
    const authorAvatarHtml = buildPostAvatarHtml(sourcePost?.user, initials);
    const authorIsExpert = !!sourcePost?.user?.is_expert || (sourcePost?.user_id === currentUser?.id && currentUserIsExpert);
    const expertAuthorBadge = authorIsExpert && typeof getExpertUserBadgeSvg === 'function' ? getExpertUserBadgeSvg(`full-${postId}`, 20) : '';
    const expertApprovedBadge = sourcePost && (sourcePost.expert_endorsed_at || sourcePost.is_expert_approved) && typeof getPostExpertApprovedBadgeHtml === 'function'
        ? getPostExpertApprovedBadgeHtml(`full-${postId}`)
        : '';

    if (!contentEl || !modal) return;

    // Remove any stale standalone comment modal for this post to avoid duplicate IDs
    document.querySelectorAll(`[id="comments-modal-${postId}"]`).forEach((el) => {
        if (!el.closest('#fullPostModal')) el.remove();
    });

    contentEl.innerHTML = `
        <div class="full-post-header">
            <div class="post-author-info">
                ${authorAvatarHtml}
                <div class="post-meta">
                    <div class="post-author">
                    <strong>${escapeHtml(displayName)}</strong>${expertAuthorBadge}
                        ${authorCourse ? `<span class="post-course">• ${escapeHtml(authorCourse)}</span>` : ''}
                    </div>
                    <div class="post-date">${formatDate(createdAt)}</div>
                </div>
            </div>
            ${category ? `<span class="post-category-badge">${escapeHtml(category)}</span>` : ''}
        </div>
        ${expertApprovedBadge}
        
        <div class="full-post-body">
            <h2 class="full-post-title">${escapeHtml(title || 'Untitled Post')}</h2>
            ${imageUrl ? `<img src="${imageUrl}" alt="Post image" class="full-post-image">` : ''}
            <div class="full-post-text">${formatMarkdown(body)}</div>
        </div>
        
        <div class="full-post-actions">
            <div class="post-actions">
                <button class="post-action-btn upvote-btn" data-post-id="${postId}" title="Upvote">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                        <path d="M12 19V5M5 12l7-7 7 7"></path>
                    </svg>
                    <span class="upvote-count">${sourcePost?.upvotes_count || 0}</span>
                </button>
                <button class="post-action-btn downvote-btn" data-post-id="${postId}" title="Downvote">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                        <path d="M12 5v14M5 12l7 7 7-7"></path>
                    </svg>
                    <span class="downvote-count">${sourcePost?.downvotes_count || 0}</span>
                </button>
                <button class="post-action-btn comment-btn" data-post-id="${postId}" title="Comment">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                    </svg>
                    <span class="comment-count">0</span>
                </button>
                <button class="post-action-btn bookmark-btn" data-post-id="${postId}" title="Bookmark">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
                    </svg>
                </button>
                <button class="post-action-btn full-post-share-btn" data-post-id="${postId}" title="Share" aria-label="Share post">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.7 6.8-4.4m-6.8 7 6.8 4.1"/></svg>
                </button>
            </div>
        </div>
        
        <div class="full-post-comments" id="comments-modal-${postId}">
            <h3>Comments</h3>
            <div class="comment-reply-hint" id="comment-reply-hint-${postId}" style="display:none;"></div>
            <div class="comment-form">
                <input type="text" class="comment-input" id="comment-input-${postId}" placeholder="Write a comment or reply…" maxlength="500">
                <button class="btn-primary" id="fullPostCommentBtn">Post</button>
            </div>
            <div class="comments-list" id="comments-list-${postId}">
                <p style="text-align:center;color:#636e72;">Loading comments...</p>
            </div>
        </div>
    `;

    modal.classList.remove('hidden');

    // Load threaded comments using the existing system (supports replies)
    loadComments(postId);

    const commentsHost = document.getElementById(`comments-modal-${postId}`);

    // Reply / show-more delegation (same logic as openCommentThread)
    commentsHost?.addEventListener('click', (e) => {
        if (e.target.closest('.comment-reply-cancel-btn')) {
            e.preventDefault();
            setCommentReplyTarget(postId, '', '');
            return;
        }
        const moreBtn = e.target.closest('.btn-show-more-replies');
        if (moreBtn) {
            e.preventDefault();
            const tid = moreBtn.getAttribute('data-replies-extra');
            const box = tid ? document.getElementById(tid) : null;
            const cnt = parseInt(moreBtn.getAttribute('data-hidden-count') || '0', 10) || 0;
            if (!box) return;
            const expanded = moreBtn.getAttribute('aria-expanded') === 'true';
            if (expanded) {
                box.hidden = true;
                moreBtn.setAttribute('aria-expanded', 'false');
                moreBtn.textContent = `See ${cnt} more ${cnt === 1 ? 'reply' : 'replies'}`;
            } else {
                box.hidden = false;
                moreBtn.setAttribute('aria-expanded', 'true');
                moreBtn.textContent = 'Show fewer replies';
            }
            return;
        }
        const replyBtn = e.target.closest('.btn-reply');
        if (replyBtn) {
            e.preventDefault();
            setCommentReplyTarget(
                postId,
                replyBtn.getAttribute('data-comment-id'),
                replyBtn.getAttribute('data-author-name') || ''
            );
        }
    });

    // Enter key submits comment
    document.getElementById(`comment-input-${postId}`)?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('fullPostCommentBtn')?.click();
        }
    });

    // Post comment button
    document.getElementById('fullPostCommentBtn')?.addEventListener('click', async () => {
        const btn = document.getElementById('fullPostCommentBtn');
        await submitComment(postId, btn);
        const countEl = modal.querySelector('.comment-count');
        if (countEl) {
            countEl.textContent = document.querySelectorAll(`#comments-list-${postId} .comment-thread`).length;
        }
    });

    // Comment action button scrolls to / focuses the comment input
    modal.querySelector('.full-post-actions .comment-btn')?.addEventListener('click', () => {
        document.getElementById(`comments-modal-${postId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setTimeout(() => document.getElementById(`comment-input-${postId}`)?.focus(), 300);
    });

    // Vote buttons in modal
    modal.querySelector('.full-post-actions .upvote-btn')?.addEventListener('click', () => {
        const actionsEl = modal.querySelector('.full-post-actions');
        if (actionsEl && typeof upvotePost === 'function') upvotePost(postId, actionsEl);
    });
    modal.querySelector('.full-post-actions .downvote-btn')?.addEventListener('click', () => {
        const actionsEl = modal.querySelector('.full-post-actions');
        if (actionsEl && typeof downvotePost === 'function') downvotePost(postId, actionsEl);
    });

    // Bookmark button in modal
    modal.querySelector('.full-post-actions .bookmark-btn')?.addEventListener('click', () => {
        const actionsEl = modal.querySelector('.full-post-actions');
        if (actionsEl && typeof toggleBookmark === 'function') toggleBookmark(postId, actionsEl);
    });
    modal.querySelector('.full-post-share-btn')?.addEventListener('click', (e) => {
        void sharePost(e, postId, sourcePost || { title, body });
    });
}

function closeFullPostModal() {
    document.getElementById('fullPostModal')?.classList.add('hidden');
}

async function submitReport() {
    const reason = document.getElementById('reportReason')?.value?.trim();
    const details = document.getElementById('reportDetails')?.value?.trim() || '';
    const submitBtn = document.getElementById('submitReportBtn');

    if (!currentPostIdToReport) {
        CustomAlert.show('Oops!', 'No post selected to report.');
        return;
    }
    const reportedPost = allPosts.find((p) => p.id === currentPostIdToReport);
    if (reportedPost?.user_id === currentUser?.id) {
        CustomAlert.show('Report', 'You cannot report your own post.');
        return;
    }
    if (!reason) {
        CustomAlert.show('Oops!', 'Please select a reason for reporting.');
        return;
    }

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting...';
    }

    try {
        const { error } = await supabase.from('flagged_content').insert({
            post_id: currentPostIdToReport,
            flagged_by: currentUser.id,
            reason: details ? `${reason}: ${details}` : reason,
            status: 'pending'
        });
        if (error) throw error;

        await notifyAllAdmins({
            type: 'admin_flagged_post',
            title: 'New post reported — please review',
            message: 'A user reported a post. Open Admin Dashboard → User-reported posts to review and moderate.'
        });

        CustomAlert.show('Report submitted', 'Thanks. Our team will review this post.');
        closeReportModal();
    } catch (err) {
        console.error('Report error:', err);
        CustomAlert.show('Error', 'Failed to submit report. Please try again.');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Submit Report';
        }
    }
}

// ─── Share (MVP Feature 1.5) ─────────────────────────────────────────────────
async function sharePost(e, postId, post) {
    e.preventDefault();
    try {
        // Track share in database
        try {
            await supabase.from('post_shares').upsert({
                post_id: postId,
                user_id: currentUser.id
            }, { onConflict: 'post_id,user_id' });
        } catch { /* table might not exist yet */ }

        if (navigator.share) {
            await navigator.share({ title: post.title, text: post.body || '', url: window.location.href });
        } else {
            await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}#post-${postId}`);
            CustomAlert.show('Success!', 'Link copied to clipboard!');
        }
    } catch (err) { console.error('Share error:', err); }
}

// ─── Delete ──────────────────────────────────────────────────────────────────
async function deleteMyPost(postId) {
    const success = await deletePost(postId); // defined in 0_Utilities.js
    if (success) await loadPosts();
}

// ─── Menu toggle ─────────────────────────────────────────────────────────────
function togglePostMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    const dropdown = e.target.closest('.post-menu').querySelector('.menu-dropdown');
    document.querySelectorAll('.menu-dropdown.active').forEach(m => {
        if (m !== dropdown) m.classList.remove('active');
    });
    dropdown.classList.toggle('active');
}
document.addEventListener('click', () => {
    document.querySelectorAll('.menu-dropdown.active').forEach(m => m.classList.remove('active'));
});

// ─── Create Post (Updated with Moderation) ──────────────────────────────────
async function createPost() {
    const title  = document.getElementById('postTitle').value.trim();
    const body   = document.getElementById('postContent').value.trim();
    const hashtagError = document.getElementById('hashtagError');
    const categorySelect = document.getElementById('postCategory');
    const selectedCategory = categorySelect ? categorySelect.value : null;

    if (!title) { CustomAlert.show('Oops!', 'Please enter a post title!'); return; }
    if (!selectedCategory) { CustomAlert.show('Oops!', 'Please select a category before posting.'); return; }
    if (hashtags.length === 0) {
        hashtagError.textContent   = 'At least 1 hashtag is required!';
        hashtagError.style.display = 'block';
        return;
    }
    hashtagError.style.display = 'none';

    const postingCheck = await checkPostingAllowed(supabase, currentUser.id);
    if (!postingCheck.allowed) {
        CustomAlert.show('Posting restricted', postingCheck.message || 'You cannot create posts right now.');
        return;
    }

    const submitBtn = document.getElementById('submitPostBtn');
    submitBtn.disabled    = true;
    
    // --- START MODERATION BLOCK ---
    submitBtn.textContent = 'Scanning content...';
    let moderationResult = null;
    try {
        moderationResult = await analyzeContentWithGemini(title, body, hashtags);

        if (!moderationResult.approved) {
            submitBtn.disabled    = false;
            submitBtn.textContent = 'Post';
            const flags = Array.isArray(moderationResult.flags) ? moderationResult.flags : [];
            const src = moderationResult.source || '';
            const scannerDown =
                flags.includes('ai_unavailable') ||
                flags.includes('moderation_request_error') ||
                src === 'edge-function-fallback' ||
                src === 'fallback' ||
                src === 'edge-function-error';

            if (scannerDown) {
                const debugNote = moderationResult.debug ? `\n\nDebug: ${moderationResult.debug}` : '';
                CustomAlert.show(
                    'Moderation temporarily unavailable',
                    `We could not reach the content scanner, so your post was not published. Please try again in a few minutes.${debugNote}`
                );
            } else {
                try {
                    await supabase.from('ai_moderation_attempts').insert({
                        user_id: currentUser.id,
                        title_preview: title.slice(0, 300),
                        reason: (moderationResult.reason || '').slice(0, 2000)
                    });
                } catch (logErr) {
                    console.warn('ai_moderation_attempts insert skipped:', logErr?.message || logErr);
                }
                CustomAlert.show('Post blocked by AI moderation.', `Reason: ${moderationResult.reason || 'Content violates community guidelines.'}`);
            }
            return;
        }
    } catch (modError) {
        console.error("Moderation Error:", modError);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Post';
        CustomAlert.show('Moderation unavailable', 'AI moderation is currently unavailable. Please try again in a moment.');
        return;
    }
    // --- END MODERATION BLOCK ---

    submitBtn.textContent = 'Publishing...';

    try {
        await ensureUserExists(currentUser);

        let imageUrl = null;
        if (selectedImageFile) {
            const fileName = `${currentUser.id}/${Date.now()}_${selectedImageFile.name}`;
            const { error: uploadError } = await supabase.storage
                .from('post-images')
                .upload(fileName, selectedImageFile, { upsert: true });
            if (uploadError) throw uploadError;
            const { data: publicData } = supabase.storage.from('post-images').getPublicUrl(fileName);
            imageUrl = publicData.publicUrl;
        }

        // Admins and experts bypass post approval; everyone else goes pending
        const bypassApproval = !!(currentUserIsAdmin || currentUserIsExpert);
        const { data: newPost, error } = await supabase.from('posts').insert([{
            user_id:  currentUser.id,
            title:    title,
            body:     body || null,
            image_url: imageUrl,
            hashtags: hashtags.join(' ') || null,
            category: selectedCategory || null,
            status:   bypassApproval ? 'published' : 'pending'
        }]).select().single();

        if (error) throw error;

        if (bypassApproval) {
            CustomAlert.show('Post Created!', 'Your post has been created successfully and is now visible in the feed.');
        } else {
            CustomAlert.show('Post Submitted!', 'Your post was submitted and will appear in the feed once an admin approves it.');
        }
        document.getElementById('createPostModal').classList.add('hidden');
        resetPostForm();
        selectedImageFile = null;
        await loadPosts();
    } catch (err) {
        console.error('Post error:', err);
        CustomAlert.show('Failed to publish post.', err.message || 'Unknown error');
    } finally {
        submitBtn.disabled    = false;
        submitBtn.textContent = 'Post';
    }
}

// ─── Hashtags ─────────────────────────────────────────────────────────────────
function handleHashtagInput(e) {
    const tags = e.target.value.split(/[\s,]+/).filter(t => t.length > 0);
    hashtags   = tags.map(t => t.startsWith('#') ? t : '#' + t);
    const container = document.getElementById('hashtagList');
    if (container) {
        container.innerHTML = hashtags.map((tag, i) => `
            <span class="hashtag-chip">
                ${tag}
                <span class="hashtag-remove" onclick="removeHashtag(${i})">×</span>
            </span>`).join('');
    }
}

window.removeHashtag = function(index) {
    hashtags.splice(index, 1);
    const input = document.getElementById('postHashtags');
    if (input) { input.value = hashtags.join(' '); handleHashtagInput({ target: input }); }
};

// ─── Image handling ───────────────────────────────────────────────────────────
function handleImageSelect(e) {
    selectedImageFile = e.target.files[0];
    if (!selectedImageFile) return;
    const preview = document.getElementById('previewImg');
    const wrap    = document.getElementById('imagePreview');
    if (preview) preview.src = URL.createObjectURL(selectedImageFile);
    if (wrap)    wrap.style.display = 'block';
}

function removeSelectedImage() {
    selectedImageFile = null;
    const wrap  = document.getElementById('imagePreview');
    const input = document.getElementById('postImage');
    if (wrap)  wrap.style.display  = 'none';
    if (input) input.value = '';
}

function updateContentCounter() {
    const postContent = document.getElementById('postContent');
    const counter = document.getElementById('contentCount');
    if (!postContent || !counter) return;
    counter.textContent = `${postContent.value.length}/5000`;
}

function wrapSelection(textarea, prefix, suffix = prefix, fallbackText = 'text') {
    const start = textarea.selectionStart || 0;
    const end = textarea.selectionEnd || 0;
    const selected = textarea.value.slice(start, end);
    const insertText = selected ? `${prefix}${selected}${suffix}` : `${prefix}${fallbackText}${suffix}`;

    textarea.setRangeText(insertText, start, end, 'end');
    if (!selected) {
        const cursorPos = start + prefix.length;
        textarea.setSelectionRange(cursorPos, cursorPos + fallbackText.length);
    }
    textarea.focus();
    updateContentCounter();
}

function addLinePrefix(textarea, prefix) {
    const start = textarea.selectionStart || 0;
    const end = textarea.selectionEnd || 0;
    const selected = textarea.value.slice(start, end);
    const source = selected || 'List item';
    const lines = source.split('\n').map((line, idx) => {
        if (!line.trim()) return line;
        if (prefix === 'number') return `${idx + 1}. ${line}`;
        return `- ${line}`;
    }).join('\n');

    textarea.setRangeText(lines, start, end, 'end');
    textarea.focus();
    updateContentCounter();
}

function setupPostEditorToolbar() {
    const textarea = document.getElementById('postContent');
    if (!textarea) return;

    const editorTools = document.querySelectorAll('.editor-tool');

    editorTools.forEach((btn) => {
        btn.addEventListener('click', () => {
            const format = btn.getAttribute('data-format');
            if (!format) return;

            switch (format) {
                case 'bold':
                    wrapSelection(textarea, '**', '**', 'bold text');
                    break;
                case 'italic':
                    wrapSelection(textarea, '*', '*', 'italic text');
                    break;
                case 'underline':
                    wrapSelection(textarea, '__', '__', 'underlined text');
                    break;
                case 'bullet':
                    addLinePrefix(textarea, 'bullet');
                    break;
                case 'number':
                    addLinePrefix(textarea, 'number');
                    break;
                default:
                    break;
            }
        });
    });

    const colorInput = document.getElementById('postTextColor');
    colorInput?.addEventListener('input', () => {
        const hex = colorInput.value || '#1dd1a1';
        wrapSelection(textarea, `[color=${hex}]`, '[/color]', 'colored text');
    });
}

function resetPostForm() {
    ['postTitle','postContent','postHashtags'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const hl = document.getElementById('hashtagList');
    if (hl) hl.innerHTML = '';
    hashtags = [];
    removeSelectedImage();
    const tc = document.getElementById('titleCount');
    const cc = document.getElementById('contentCount');
    if (tc) tc.textContent = '0/300';
    if (cc) cc.textContent = '0/5000';
}

// ─── Utility ──────────────────────────────────────────────────────────────────
// escapeHtml() and formatDate() defined in 0_Utilities.js

function scrollToPost(postId) {
    const el = document.querySelector(`.post-card[data-post-id="${postId}"]`)
        || document.querySelector(`[data-post-id="${postId}"]`);
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.classList.add('highlight');
        setTimeout(() => el.classList.remove('highlight'), 2000);
    }
}

async function runNotificationDeepLink(payload) {
    const postId = payload?.postId;
    if (!postId) return;
    const commentId = payload.commentId || null;
    const openComments = !!payload.openComments;

    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 120)));

    const post = allPosts.find((p) => p.id === postId);
    if (!post) {
        if (typeof CustomAlert !== 'undefined' && CustomAlert.show) {
            CustomAlert.show('Post', 'That post is not in your current feed. Try refreshing.', 'info');
        }
        return;
    }

    scrollToPost(postId);

    if (openComments) {
        await openCommentThread(postId, post, { forceReplace: true });
        if (commentId) {
            await new Promise((r) => setTimeout(r, 280));
            const row = document.querySelector(`.comment-thread[data-comment-id="${commentId}"]`);
            if (row) {
                row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                row.classList.add('comment-highlight');
                setTimeout(() => row.classList.remove('comment-highlight'), 2200);
            }
        }
    }
}

async function tryConsumeNotificationDeepLink() {
    const raw = sessionStorage.getItem(GCFS_NOTIF_NAV_KEY);
    if (!raw) return;
    sessionStorage.removeItem(GCFS_NOTIF_NAV_KEY);
    try {
        const payload = JSON.parse(raw);
        await runNotificationDeepLink(payload);
    } catch {
        /* ignore */
    }
}

function queueNotificationDeepLinkAndGoFeed(payload) {
    try {
        sessionStorage.setItem(GCFS_NOTIF_NAV_KEY, JSON.stringify(payload));
    } catch {
        /* ignore */
    }
    window.location.href = '/HTML/2_Main_Feed.html';
}

function applyMobileSidebarDefaults() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar || !window.matchMedia) return;
    if (window.matchMedia('(max-width: 1024px)').matches) {
        sidebar.classList.add('hidden');
    }
}

function syncSidebarByViewport() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar || !window.matchMedia) return;
    if (window.matchMedia('(min-width: 1025px)').matches) {
        sidebar.classList.remove('hidden');
    }
}

// ─── Event Listeners ──────────────────────────────────────────────────────────
function setupEventListeners() {
    applyMobileSidebarDefaults();
    window.addEventListener('resize', syncSidebarByViewport);

    // filter tabs
    document.querySelectorAll('.filter-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.dataset.filter;
            displayPostsByFilter(currentFilter);
        });
    });

    // search
    const searchInput = document.querySelector('.search-input');
    if (searchInput) {
        searchInput.setAttribute('role', 'combobox');
        searchInput.setAttribute('aria-autocomplete', 'list');
        searchInput.setAttribute('aria-expanded', 'false');
        searchInput.setAttribute('autocomplete', 'off');
        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.trim();
            searchSuggestionQuery = query;
            postSearchResults = query ? getPostsMatchingSearch(query).slice(0, 6) : [];
            userSearchResults = [];
            renderSearchSuggestions(postSearchResults, [], query);
            void searchUsers(query);
        });
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                moveSearchSuggestionSelection(e.key === 'ArrowDown' ? 1 : -1);
                return;
            }
            if (e.key === 'Enter') {
                const dropdown = getSearchSuggestionsDropdown();
                const selectedSuggestion = dropdown?.querySelector('[role="option"][aria-selected="true"]');
                if (selectedSuggestion) {
                    e.preventDefault();
                    selectedSuggestion.click();
                    return;
                }
                e.preventDefault();
                submitFeedSearch();
            } else if (e.key === 'Escape') {
                hideSearchSuggestions();
            }
        });
    }
    document.querySelector('.search-btn')?.addEventListener('click', () => {
        submitFeedSearch();
    });
    document.addEventListener('click', (e) => {
        const searchContainer = document.querySelector('.search-container');
        if (searchContainer && !searchContainer.contains(e.target)) {
            hideSearchSuggestions();
        }
    });

    // filter menu toggle
    document.getElementById('filterMenuToggle')?.addEventListener('click', () => {
        document.getElementById('filterMenu')?.classList.toggle('hidden');
    });

    // create post modal
    document.getElementById('createPostBtn')?.addEventListener('click', () => {
        document.getElementById('createPostModal').classList.remove('hidden');
    });
    document.getElementById('submitPostBtn')?.addEventListener('click', createPost);
    document.getElementById('cancelPostBtn')?.addEventListener('click', () => {
        document.getElementById('createPostModal').classList.add('hidden');
        resetPostForm();
    });

    document.getElementById('closePostModal')?.addEventListener('click', () => {
        document.getElementById('createPostModal')?.classList.add('hidden');
        resetPostForm();
    });

    // full post modal
    document.getElementById('closeFullPostModal')?.addEventListener('click', closeFullPostModal);
    document.getElementById('fullPostModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'fullPostModal') closeFullPostModal();
    });

    document.getElementById('submitReportBtn')?.addEventListener('click', submitReport);
    document.getElementById('cancelReportBtn')?.addEventListener('click', closeReportModal);
    document.getElementById('closeReportModal')?.addEventListener('click', closeReportModal);

    // image upload
    document.getElementById('postImage')?.addEventListener('change', handleImageSelect);
    document.getElementById('removeImageBtn')?.addEventListener('click', removeSelectedImage);

    // hashtags
    document.getElementById('postHashtags')?.addEventListener('input', handleHashtagInput);

    // close modals
    document.querySelectorAll('.modal-close').forEach(btn => {
        btn.addEventListener('click', (e) => e.target.closest('.modal')?.classList.add('hidden'));
    });

    // dark mode — handled by 0_Footer.js via toggleDarkMode()

    // logout
    document.getElementById('logoutBtn')?.addEventListener('click', async () => {
        await supabase.auth.signOut();
        window.location.href = '/HTML/1_LogIn_Page.html';
    });

    // notifications
    document.querySelector('.notification-btn')?.addEventListener('click', openNotificationsModal);

    // char counters
    document.getElementById('postTitle')?.addEventListener('input', (e) => {
        const el = document.getElementById('titleCount');
        if (el) el.textContent = `${e.target.value.length}/300`;
    });
    document.getElementById('postContent')?.addEventListener('input', (e) => {
        updateContentCounter();
    });

    // Category filter buttons
    document.querySelectorAll('.category-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.category-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentCategory = btn.dataset.category;
            displayPostsByFilter(currentFilter);
        });
    });

    // Wellness profile modal
    document.getElementById('saveWellnessProfile')?.addEventListener('click', saveWellnessProfile);
    document.getElementById('skipWellnessProfile')?.addEventListener('click', () => {
        document.getElementById('wellnessProfileModal')?.classList.add('hidden');
        localStorage.setItem(getWellnessSkipKey(), 'true');
    });
    document.getElementById('closeWellnessModal')?.addEventListener('click', () => {
        document.getElementById('wellnessProfileModal')?.classList.add('hidden');
        localStorage.setItem(getWellnessSkipKey(), 'true');
    });

    setupPostEditorToolbar();
}

// ─── Wellness Profile (MVP Feature 1.1) ──────────────────────────────────────
async function checkAndShowWellnessProfile() {
    const setupStatus = await getRequiredProfileSetupStatus(currentUser);
    // Legacy profiles with saved username and course are already complete. New
    // accounts now complete Lifestyle & For You on the Profile page, where the
    // sequence is persisted and cannot be skipped.
    if (!setupStatus.checked || setupStatus.phase === 'complete') return;
    await redirectIncompleteProfileSetup(currentUser);
}

async function saveWellnessProfile() {
    const goals = Array.from(document.querySelectorAll('input[name="fitness_goals"]:checked'))
        .map(cb => cb.value);
    const activityLevel = document.getElementById('activityLevel')?.value || null;
    const healthPrefs = Array.from(document.querySelectorAll('input[name="health_prefs"]:checked'))
        .map(cb => cb.value);
    const interests = Array.from(document.querySelectorAll('input[name="content_interests"]:checked'))
        .map(cb => cb.value);
    const bio = document.getElementById('wellnessBio')?.value?.trim() || null;
    const personality_snapshot =
        typeof readLifestylePersonalitySnapshot === 'function' ? readLifestylePersonalitySnapshot('feed') : {};
    const experience_story =
        typeof readLifestyleExperienceStory === 'function' ? readLifestyleExperienceStory('feed') : null;

    try {
        const { error } = await supabase.from('wellness_profiles').upsert({
            user_id: currentUser.id,
            fitness_goals: goals,
            activity_level: activityLevel,
            health_preferences: healthPrefs,
            content_interests: interests,
            bio: bio,
            personality_snapshot,
            experience_story,
            updated_at: new Date().toISOString()
        }, { onConflict: 'user_id' });
        if (error) throw error;

        localStorage.setItem(getWellnessSkipKey(), 'true');
        document.getElementById('wellnessProfileModal')?.classList.add('hidden');
        CustomAlert.show(
            'Lifestyle saved',
            'Your For You tab will rank posts using your quiz and optional private notes.'
        );
    } catch (err) {
        console.error('Wellness profile save error:', err);
        CustomAlert.show('Error', 'Failed to save profile. If this persists, run the latest SQL migration for wellness_profiles.');
    }
}

/** Keyword hints per quiz answer — lightweight text match for feed ranking only. */
const LIFESTYLE_PERSONALITY_KEYWORDS = {
    motivation: {
        accountability: ['buddy', 'partner', 'accountability', 'together', 'group', 'class', 'team', 'coach', 'check'],
        self_driven: ['solo', 'routine', 'discipline', 'independent', 'habit', 'myself'],
        competition: ['challenge', 'compete', 'race', 'leaderboard', 'record', 'win', 'pr '],
        curiosity: ['learn', 'science', 'research', 'experiment', 'why ', 'tip', 'new ']
    },
    training_vibe: {
        structured_plans: ['program', 'plan', 'week', 'schedule', 'split', 'sets', 'reps'],
        flexible_intuitive: ['listen', 'intuitive', 'flexible', 'adjust', 'when i can'],
        short_blitz: ['quick', 'hiit', 'short', '10 min', '15 min', 'burst'],
        slow_steady: ['walk', 'steady', 'gradual', 'long term', 'consistent', 'sustainable']
    },
    social_energy: {
        solo_focus: ['solo', 'alone', 'quiet', 'focus'],
        small_circle: ['friend', 'partner', 'roommate', 'small'],
        community_energy: ['community', 'club', 'campus', 'group', 'class']
    },
    learning_style: {
        step_by_step: ['step', 'guide', 'how to', 'tutorial', 'beginner'],
        big_picture: ['overview', 'framework', 'strategy', 'big picture'],
        stories_examples: ['story', 'experience', 'journey', 'worked', 'example']
    }
};

function lifestylePersonalityScore(snapshot, textBlob) {
    if (!snapshot || typeof snapshot !== 'object') return 0;
    let s = 0;
    for (const dim of Object.keys(LIFESTYLE_PERSONALITY_KEYWORDS)) {
        const val = snapshot[dim];
        const words = LIFESTYLE_PERSONALITY_KEYWORDS[dim]?.[val];
        if (!words) continue;
        for (const w of words) {
            if (textBlob.includes(w)) s += 0.4;
        }
    }
    return Math.min(3.5, s);
}

function tokenOverlapScore(textBlob, tokens) {
    if (!tokens || !tokens.length) return 0;
    let hits = 0;
    for (const t of tokens) {
        if (t && t.length > 2 && textBlob.includes(t)) hits++;
    }
    return Math.min(4, hits * 0.55);
}

function healthPreferenceScore(prefs, textBlob) {
    if (!Array.isArray(prefs) || !prefs.length) return 0;
    let s = 0;
    if (prefs.includes('vegan') && /(vegan|plant[- ]based)/.test(textBlob)) s += 1.2;
    if (prefs.includes('vegetarian') && /(vegetarian|veggie|plant)/.test(textBlob)) s += 1;
    if (prefs.includes('gluten_free') && /(gluten|celiac)/.test(textBlob)) s += 1;
    if (prefs.includes('low_carb') && /(low carb|keto|carb)/.test(textBlob)) s += 1;
    if (prefs.includes('high_protein') && /(protein|high protein)/.test(textBlob)) s += 1;
    return Math.min(3, s);
}

// ─── Personalized Recommendations (MVP Feature 1.3) ──────────────────────────
async function getPersonalizedRecommendations(sourcePosts, limit = 10) {
    const pool = sourcePosts && sourcePosts.length ? sourcePosts : allPosts;
    try {
        const { data: profile } = await supabase
            .from('wellness_profiles')
            .select('*')
            .eq('user_id', currentUser.id)
            .single();

        if (!profile) return pool.slice(0, limit);

        const userCategories =
            Array.isArray(profile.content_interests)
                ? profile.content_interests
                : Array.isArray(profile.interested_categories)
                  ? profile.interested_categories
                  : [];
        const userGoals = Array.isArray(profile.fitness_goals) ? profile.fitness_goals : [];
        let snapshot = profile.personality_snapshot;
        if (typeof snapshot === 'string') {
            try {
                snapshot = JSON.parse(snapshot);
            } catch {
                snapshot = {};
            }
        }
        if (!snapshot || typeof snapshot !== 'object') snapshot = {};
        const prefs = Array.isArray(profile.health_preferences) ? profile.health_preferences : [];
        const personalizeBlob = [profile.experience_story, profile.bio].filter(Boolean).join(' ');
        const userTokens =
            typeof extractFeedPersonalizationTokens === 'function'
                ? extractFeedPersonalizationTokens(personalizeBlob)
                : [];

        let scored = pool.map((post) => {
            let score = 0;
            if (post.category && userCategories.includes(post.category)) score += 3;
            const textBlob = `${post.title || ''} ${post.body || ''} ${post.hashtags || ''}`.toLowerCase();
            if (userGoals.includes('weight_loss') && /(fat loss|weight loss|calorie|cardio)/.test(textBlob)) score += 2;
            if (userGoals.includes('muscle_gain') && /(muscle|strength|protein|hypertrophy)/.test(textBlob)) score += 2;
            if (userGoals.includes('stress_management') && /(stress|mindful|meditation|anxiety|sleep)/.test(textBlob)) score += 2;
            if (userGoals.includes('better_sleep') && /(sleep|insomnia|rest|circadian)/.test(textBlob)) score += 1.8;
            if (userGoals.includes('endurance') && /(run|cardio|endurance|5k|marathon|bike)/.test(textBlob)) score += 1.8;
            if (userGoals.includes('flexibility') && /(stretch|yoga|mobility|flex)/.test(textBlob)) score += 1.8;
            score += lifestylePersonalityScore(snapshot, textBlob);
            score += tokenOverlapScore(textBlob, userTokens);
            score += healthPreferenceScore(prefs, textBlob);
            if (post.upvotes_count > 5) score += 1;
            if (post.comments_count > 2) score += 1;
            return { ...post, recommendScore: score };
        });

        scored.sort((a, b) => b.recommendScore - a.recommendScore);
        return scored.slice(0, limit);
    } catch {
        return pool.slice(0, limit);
    }
}
