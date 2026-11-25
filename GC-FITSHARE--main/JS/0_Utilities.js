/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 0_Utilities.js — SHARED LIBRARY (load on every authenticated page before others)
 * ═══════════════════════════════════════════════════════════════════════════ 
 *
 * PURPOSE
 *   Single Supabase client, auth helper, HTML safety, dates, notifications,
 *   query helpers, expert/admin badges, and shared delete/endorse logic.
 *
 * DEPENDS ON
 *   @supabase/supabase-js on `window` (from CDN in each HTML page).
 *
 * FIND YOUR WAY AROUND (search for these banner titles in this file)
 *   SUPABASE CONFIGURATION | AUTHENTICATION | DARK MODE MANAGEMENT
 *   TEXT UTILITIES | NOTIFICATION DISPLAY | DATE FORMATTING
 *   SUPABASE QUERY HELPERS | Centralized Delete Post | Expert badges & endorsements
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────────────────────────
// SUPABASE CONFIGURATION & CLIENT INITIALIZATION
// ─────────────────────────────────────────────────────────────────────────────
// The anon (publishable) key is safe to ship in the browser; real protection is
// Row Level Security and Edge Functions. Never put the service_role key here.

const SUPABASE_URL = "https://sjhpalnvneposzilyfux.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_2maz8AxDO5OkCDsU0aDGzA_JsuL7u-n";

// Initialize Supabase client (created dynamically in browser)
let supabaseClient = null;

function getSupabaseClient() {
    if (!supabaseClient && window.supabase) {
        supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
    return supabaseClient;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTHENTICATION MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if user is authenticated, redirect to login if not
 * @returns {object} Current authenticated user or null
 */
async function checkUserAuthentication() {
    try {
        let supabase = getSupabaseClient();
        if (!supabase) {
            // Give CDN script/client a short window to initialize before failing.
            for (let i = 0; i < 10 && !supabase; i++) {
                await new Promise((resolve) => setTimeout(resolve, 150));
                supabase = getSupabaseClient();
            }
        }

        if (!supabase) {
            console.error('Supabase client not initialized');
            return null;
        }

        let user = null;
        let authError = null;

        // Retry auth fetch to avoid logging users out on transient network failures.
        for (let attempt = 0; attempt < 2; attempt++) {
            const { data, error } = await supabase.auth.getUser();
            if (!error) {
                user = data?.user || null;
                authError = null;
                break;
            }
            authError = error;
            await new Promise((resolve) => setTimeout(resolve, 200));
        }

        if (!user) {
            const { data: sessionData } = await supabase.auth.getSession();
            user = sessionData?.session?.user || null;
        }

        if (!user) {
            // Only redirect when genuinely unauthenticated.
            if (!authError) {
                window.location.href = '/HTML/1_LogIn_Page.html';
            }
            return null;
        }

        return user;
    } catch (error) {
        console.error('Auth error:', error);
        // Avoid forced logout loops on temporary runtime/network issues.
        return null;
    }
}

/**
 * Ensure user exists in users table (create if missing)
 * Called after successful login or before posting
 * @param {object} user - Authenticated user object from Supabase
 * @returns {boolean} True if user record exists or was created
 */
async function ensureUserExists(user) {
    if (!user) return false;

    try {
        const supabase = getSupabaseClient();

        // Check if user exists in users table
        const { data: existingUser, error: checkError } = await supabase
            .from('users')
            .select('id')
            .eq('id', user.id)
            .single();

        // User already exists
        if (!checkError && existingUser) {
            return true;
        }

        // User doesn't exist, create them
        const { error: insertError } = await supabase
            .from('users')
            .insert([{
                id: user.id,
                email: user.email,
                full_name: user.user_metadata?.full_name || user.email.split('@')[0],
                is_admin: false,
                is_expert: false
            }]);

        if (insertError) {
            console.error('Error creating user record:', insertError);
            return false;
        }

        return true;
    } catch (error) {
        console.error('Error ensuring user exists:', error);
        return false;
    }
}

/**
 * Required first-time profile data lives in the existing users row. A profile
 * becomes eligible for the regular app only after both fields were persisted.
 * Privileged accounts keep their existing role-specific entry flow.
 */
function hasRequiredProfileInformation(profile) {
    return Boolean(
        profile &&
        typeof profile.username === 'string' && profile.username.trim() &&
        typeof profile.course === 'string' && profile.course.trim()
    );
}

function getProfileSetupStage(profile) {
    let visibility = profile?.profile_visibility;
    if (typeof visibility === 'string') {
        try {
            visibility = JSON.parse(visibility);
        } catch {
            visibility = null;
        }
    }
    const stage = visibility?.profile_setup_stage;
    return stage === 'lifestyle' || stage === 'complete' ? stage : null;
}

async function getRequiredProfileSetupStatus(user) {
    if (!user?.id) {
        return { checked: false, required: false, profile: null };
    }

    const client = getSupabaseClient();
    if (!client) {
        return { checked: false, required: false, profile: null };
    }

    try {
        const { data: profile, error: profileError } = await client
            .from('users')
            .select('id, username, course, profile_visibility, is_admin, is_expert')
            .eq('id', user.id)
            .maybeSingle();

        if (profileError) {
            console.warn('Profile setup status could not be loaded:', profileError.message || profileError);
            return { checked: false, required: false, profile: null };
        }

        if (!profile) {
            return { checked: true, required: true, phase: 'profile', profile: null };
        }

        if (profile.is_admin || profile.is_expert) {
            return { checked: true, required: false, phase: 'complete', profile };
        }

        const { data: adminRecord, error: adminError } = await client
            .from('admins')
            .select('id')
            .eq('user_id', user.id)
            .maybeSingle();

        if (adminError) {
            // Do not send a potentially privileged account into student setup
            // when its role cannot be verified. A later authenticated page load
            // will retry this check.
            console.warn('Profile setup role check could not be loaded:', adminError.message || adminError);
            return { checked: false, required: false, profile };
        }

        const savedStage = getProfileSetupStage(profile);
        const phase = adminRecord
            ? 'complete'
            : savedStage === 'lifestyle'
              ? 'lifestyle'
              : savedStage === 'complete' || hasRequiredProfileInformation(profile)
                ? 'complete'
                : 'profile';

        return { checked: true, required: phase !== 'complete', phase, profile };
    } catch (error) {
        console.warn('Profile setup status failed:', error?.message || error);
        return { checked: false, required: false, profile: null };
    }
}

/**
 * Keep incomplete non-privileged accounts on their own Profile page. The
 * Profile page opens the existing Edit Profile modal and completes the flow.
 */
async function redirectIncompleteProfileSetup(user) {
    const status = await getRequiredProfileSetupStatus(user);
    if (!status.checked || !status.required) return false;

    const currentUrl = new URL(window.location.href);
    const isProfilePage = /\/HTML\/3_Profile\.html$/i.test(currentUrl.pathname);
    const requestedProfileId = currentUrl.searchParams.get('user');
    const isOwnProfilePage = isProfilePage && (!requestedProfileId || requestedProfileId === user.id);

    if (isOwnProfilePage) return false;

    window.location.replace(`/HTML/3_Profile.html?setup=${encodeURIComponent(status.phase || 'profile')}`);
    return true;
}

/**
 * Returns whether the user may create posts (not suspended / ban expired).
 * Clears is_suspended when a timed suspension has ended.
 * @param {*} supabase Supabase client from `getSupabaseClient()`
 * @param {string} userId
 * @returns {Promise<{ allowed: boolean, message?: string }>}
 */
async function checkPostingAllowed(supabase, userId) {
    if (!supabase || !userId) {
        return { allowed: true };
    }

    let data = null;
    let error = null;
    ({ data, error } = await supabase
        .from('users')
        .select('is_suspended, suspended_until')
        .eq('id', userId)
        .maybeSingle());

    if (error && /suspended_until|column/i.test(String(error.message || ''))) {
        ({ data, error } = await supabase
            .from('users')
            .select('is_suspended')
            .eq('id', userId)
            .maybeSingle());
    }

    if (error) {
        console.warn('checkPostingAllowed:', error.message || error);
        return { allowed: true };
    }
    if (!data || !data.is_suspended) {
        return { allowed: true };
    }

    const untilRaw = data.suspended_until;
    const until = untilRaw ? new Date(untilRaw) : null;
    if (until && !Number.isNaN(until.getTime()) && until.getTime() <= Date.now()) {
        const { error: clearErr } = await supabase
            .from('users')
            .update({ is_suspended: false, suspended_until: null })
            .eq('id', userId);
        if (clearErr) {
            console.warn('Could not clear expired suspension:', clearErr.message || clearErr);
        }
        return { allowed: true };
    }
    if (until && until.getTime() > Date.now()) {
        return {
            allowed: false,
            message: `Posting is suspended until ${until.toLocaleString()}.`
        };
    }
    return {
        allowed: false,
        message: 'Your account cannot create posts right now. Contact support if you believe this is a mistake.'
    };
}

/**
 * After a successful sign-in: show a modal if posting is suspended or banned (indefinite).
 * Expired timed suspensions are cleared by checkPostingAllowed.
 */
async function maybeShowSuspensionNoticeOnLogin(supabase, userId) {
    if (!supabase || !userId || typeof checkPostingAllowed !== 'function') return;

    const posting = await checkPostingAllowed(supabase, userId);
    if (posting.allowed || !posting.message) return;

    const isTimed = /until\b/i.test(posting.message);
    const title = isTimed ? 'Posting temporarily suspended' : 'Posting restricted (ban)';

    const body = `${posting.message}\n\nYou can still browse GC FitShare. Creating new posts is disabled until this is lifted. If you have questions, use Info & Support.`;

    if (typeof CustomAlert !== 'undefined' && typeof CustomAlert.show === 'function') {
        CustomAlert.show(title, body, 'warning');
    } else {
        window.alert(`${title}\n\n${body}`);
    }
}

/**
 * Logout current user
 * @returns {boolean} True if logout successful
 */
async function logout() {
    let ok = true;
    if (typeof CustomAlert !== 'undefined' && typeof CustomAlert.confirm === 'function') {
        ok = await CustomAlert.confirm(
            'Log out',
            'Are you sure you want to log out?',
            { confirmText: 'Log out', cancelText: 'Stay signed in' }
        );
    } else if (typeof confirm === 'function') {
        ok = confirm('Are you sure you want to log out?');
    }
    if (!ok) return false;

    try {
        const supabase = getSupabaseClient();
        const { error } = await supabase.auth.signOut();
        if (error) throw error;

        window.location.href = '/HTML/1_LogIn_Page.html';
        return true;
    } catch (error) {
        console.error('Logout error:', error);
        return false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DARK MODE MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

const DARKMODE_KEY = 'gcfitshare_darkmode'; // Consistent key across all pages

/**
 * Toggle between light and dark mode
 * Updates localStorage and applies CSS classes
 */
function toggleDarkMode() {
    document.body.classList.toggle('dark-mode');
    const isDarkMode = document.body.classList.contains('dark-mode');
    localStorage.setItem(DARKMODE_KEY, isDarkMode ? 'true' : 'false');
    updateDarkModeIcon();
}

/**
 * Load dark mode preference from localStorage on page load
 */
function loadDarkModePreference() {
    const isDarkMode = localStorage.getItem(DARKMODE_KEY) === 'true';
    if (isDarkMode) {
        document.body.classList.add('dark-mode');
    }
    updateDarkModeIcon();
}

/**
 * Update dark mode toggle button icon based on current mode
 */
function updateDarkModeIcon() {
    const toggle = document.getElementById('darkModeToggle');
    if (!toggle) return;

    const isDarkMode = document.body.classList.contains('dark-mode');
    toggle.setAttribute('aria-checked', isDarkMode ? 'true' : 'false');
    const icon = toggle.querySelector('.moon-icon');
    const span = toggle.querySelector('span');

    if (isDarkMode) {
        // Show sun icon when in dark mode (to switch to light)
        icon.innerHTML = '<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>';
        span.textContent = 'Light Mode';
    } else {
        // Show moon icon for light mode (to switch to dark)
        icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';
        span.textContent = 'Dark Mode';
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEXT UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * For PostgREST `.or(...)` strings: commas/parens break the filter; trim length.
 */
function sanitizeUserSearchForOrClause(raw) {
    return String(raw ?? '')
        .replace(/[,%()]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
}

/**
 * Escape HTML special characters to prevent XSS when inserting user text into the DOM.
 * @param {string} text - Raw text to escape
 * @returns {string} Escaped HTML-safe text
 */
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Format a timestamp for feed/admin lists (relative when recent).
 * @param {string|number|Date} dateString
 * @returns {string}
 */
function formatDate(dateString) {
    const date = new Date(dateString);
    const diff = Date.now() - date.getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d ago`;
    return date.toLocaleDateString();
}

/**
 * Truncate text to a maximum length with ellipsis
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum characters to keep
 * @returns {string} Truncated text with ... if longer than maxLength
 */
function truncateText(text, maxLength = 300) {
    if (!text) return '';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
}

/** Stopwords for lightweight token overlap (feed personalization only). */
const FEED_PERSONALIZATION_STOPWORDS = new Set([
    'the', 'and', 'for', 'you', 'are', 'but', 'not', 'with', 'has', 'was', 'that', 'this', 'from',
    'have', 'your', 'how', 'can', 'any', 'all', 'too', 'also', 'just', 'like', 'get', 'got', 'when',
    'what', 'way', 'who', 'why', 'our', 'out', 'about', 'into', 'been', 'more', 'very', 'only', 'its',
    'here', 'there', 'they', 'them', 'then', 'than', 'some', 'over', 'after', 'before', 'well', 'will',
    'would', 'could', 'should', 'did', 'does', 'doing', 'make', 'made', 'want', 'need', 'really', 'much'
]);

/**
 * Tokens from free text for matching against posts (client-side ranking only).
 * @param {string} text
 * @returns {string[]}
 */
function extractFeedPersonalizationTokens(text) {
    if (!text || typeof text !== 'string') return [];
    const words = text
        .toLowerCase()
        .replace(/[^a-z0-9\s#]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !FEED_PERSONALIZATION_STOPWORDS.has(w));
    return [...new Set(words)].slice(0, 80);
}

/**
 * Read lifestyle quiz answers from the feed onboarding modal or profile edit form.
 * @param {'feed'|'profile'} context
 * @returns {Record<string, string>}
 */
function readLifestylePersonalitySnapshot(context) {
    const ids =
        context === 'feed'
            ? {
                  motivation: 'personalityMotivation',
                  training_vibe: 'personalityTraining',
                  social_energy: 'personalitySocial',
                  learning_style: 'personalityLearning'
              }
            : {
                  motivation: 'profilePersonalityMotivation',
                  training_vibe: 'profilePersonalityTraining',
                  social_energy: 'profilePersonalitySocial',
                  learning_style: 'profilePersonalityLearning'
              };
    const snap = {};
    for (const [key, id] of Object.entries(ids)) {
        const v = document.getElementById(id)?.value;
        if (v) snap[key] = v;
    }
    return snap;
}

/**
 * @param {'feed'|'profile'} context
 * @returns {string|null}
 */
function readLifestyleExperienceStory(context) {
    const id = context === 'feed' ? 'wellnessExperienceStory' : 'profileExperienceStory';
    const raw = document.getElementById(id)?.value?.trim();
    return raw || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATION DISPLAY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Show temporary notification message at top of screen
 * @param {string} message - Message to display
 * @param {number} duration - How long to show (milliseconds)
 */
function showNotification(message, duration = 3000) {
    const notif = document.getElementById('notification');
    if (!notif) {
        if (typeof CustomAlert !== 'undefined' && typeof CustomAlert.show === 'function') {
            CustomAlert.show('Notice', message, 'info');
        } else {
            console.warn('[Notice]', message);
        }
        return;
    }
    notif.textContent = message;
    notif.classList.add('show');
    setTimeout(() => {
        notif.classList.remove('show');
    }, duration);
}

// ─────────────────────────────────────────────────────────────────────────────
// DATE FORMATTING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format date for display in posts
 * @param {string|Date} dateStr - ISO date string or Date object
 * @returns {string} Formatted date (e.g., "Jan 15")
 */
function formatPostDate(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined
    });
}

/**
 * Get user initials for avatar
 * @param {string} fullName - User's full name
 * @returns {string} Initials (e.g., "JD" for "John Doe")
 */
function getUserInitials(fullName) {
    if (!fullName) return 'U';
    return fullName.split(' ').map(n => n[0]).join('').toUpperCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// SUPABASE QUERY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch user data by user ID
 * Returns null if user doesn't exist (doesn't throw error)
 * @param {string} userId - User ID to fetch
 * @returns {object|null} User data or null
 */
async function getUserById(userId) {
    try {
        const supabase = getSupabaseClient();
        const { data, error } = await supabase
            .from('users')
            .select('id, full_name, email, avatar_url, is_admin, username, course')
            .eq('id', userId)
            .single();

        return (error || !data) ? null : data;
    } catch (error) {
        console.error('Error fetching user:', error);
        return null;
    }
}

/**
 * Create anonymous user object when real user data unavailable
 * @param {string} userId - The actual user_id from database
 * @returns {object} Anonymous user placeholder
 */
function createAnonymousUser(userId) {
    return {
        id: userId,
        full_name: 'Anonymous',
        email: 'user@fitshare.com',
        username: 'anonymous',
        course: 'Unknown',
        is_admin: false
    };
}

// ─── Centralized Delete Post ─────────────────────────────────────────────────
/**
 * Delete a post safely — works from Profile page or Main Feed
 * Only allows the owner to delete their own post
 */
async function deletePost(postId) {
    if (!currentUser) {
        if (typeof CustomAlert !== 'undefined' && typeof CustomAlert.show === 'function') {
            CustomAlert.show('Authentication Required', 'You must be logged in to delete posts.', 'error');
        } else {
            console.warn('Authentication Required: You must be logged in to delete posts.');
        }
        return false;
    }

    let proceed = true;
    if (typeof CustomAlert !== 'undefined' && typeof CustomAlert.confirm === 'function') {
        proceed = await CustomAlert.confirm(
            'Delete post',
            'Are you sure you want to delete this post? This cannot be undone.',
            { confirmText: 'Delete', cancelText: 'Cancel', danger: true }
        );
    } else if (typeof confirm === 'function') {
        proceed = confirm('Are you sure you want to delete this post? This cannot be undone.');
    }
    if (!proceed) return false;

    try {
        const sb = getSupabaseClient();
        const { error } = await sb
            .from('posts')
            .delete()
            .eq('id', postId)
            .eq('user_id', currentUser.id);   // Safety check: only owner can delete

        if (error) throw error;

        // Success - refresh the current page's posts automatically
        console.log(" Post deleted successfully");
        return true;
    } catch (error) {
        console.error("Delete error:", error);
        if (typeof CustomAlert !== 'undefined' && typeof CustomAlert.show === 'function') {
            CustomAlert.show('Delete Failed', 'Failed to delete post: ' + (error.message || 'Unknown error'), 'error');
        } else {
            console.warn('Delete Failed', error.message || error);
        }
        return false;
    }
}

/**
 * Insert the same notification row for every admin (reports, expert apps, etc.).
 */
// ─── Expert badges & weekly post endorsements ───────────────────────────────

/** Max expert post endorsements per expert per week (resets Monday 00:00 local). */
function getExpertWeeklyEndorsementLimit() {
    return 3;
}

/**
 * Start of the current week (Monday 00:00:00 local time).
 */
function getStartOfWeekMondayLocal(date = new Date()) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    d.setHours(0, 0, 0, 0);
    return d;
}

/**
 * Week metadata for expert_badge_user (reporting). Uses ISO week-year / ISO week number (week 1 contains Jan 4).
 */
function getExpertGiftWeekFields(date = new Date()) {
    const monday = getStartOfWeekMondayLocal(date);
    const y = monday.getFullYear();
    const jan4 = new Date(y, 0, 4);
    const week1Monday = getStartOfWeekMondayLocal(jan4);
    const msWeek = 7 * 24 * 60 * 60 * 1000;
    let week_number = 1 + Math.floor((monday.getTime() - week1Monday.getTime()) / msWeek);
    let year = y;
    if (week_number < 1) {
        const py = y - 1;
        const prevJan4 = new Date(py, 0, 4);
        const prevWeek1Mon = getStartOfWeekMondayLocal(prevJan4);
        week_number = 1 + Math.floor((monday.getTime() - prevWeek1Mon.getTime()) / msWeek);
        year = py;
    }
    return { year, week_number: Math.max(1, week_number) };
}

function isUniqueViolationError(err) {
    const code = err?.code;
    const msg = String(err?.message || err || '');
    return code === '23505' || /duplicate key|unique constraint/i.test(msg);
}

/**
 * Count expert gifts this expert made since Monday (local), using expert_badge_user.
 */
async function countExpertEndorsementsThisWeek(supabase, expertUserId) {
    if (!supabase || !expertUserId) return 0;
    const start = getStartOfWeekMondayLocal().toISOString();
    const { count, error } = await supabase
        .from('expert_badge_user')
        .select('*', { count: 'exact', head: true })
        .eq('expert_user_id', expertUserId)
        .gte('gifted_at', start);
    if (error) {
        if (/expert_badge_user|column|schema|relation/i.test(String(error.message || ''))) {
            console.warn('expert_badge_user unavailable — run SQL/010_expert_badge_user_constraints.sql');
        } else {
            console.warn('countExpertEndorsementsThisWeek:', error.message || error);
        }
        return 0;
    }
    return count || 0;
}

/**
 * Inline SVG badge (teal → blue gradient) shown next to expert names.
 * @param {string} uniqueSuffix - keeps gradient ids unique when many SVGs on one page
 * @param {number} [sizePx=22]
 */
function getExpertUserBadgeSvg(uniqueSuffix, sizePx) {
    const size = Number(sizePx) > 0 ? Number(sizePx) : 22;
    const safe = String(uniqueSuffix || 'id').replace(/[^a-zA-Z0-9_-]/g, '') || 'id';
    const gid = `expert-user-grad-${safe}`;
    return `<span class="expert-user-badge" title="Wellness expert" aria-label="Wellness expert">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" class="expert-user-badge-svg" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="${gid}" x1="0%" y1="100%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#1dd1a1"/>
      <stop offset="100%" stop-color="#0984e3"/>
    </linearGradient>
  </defs>
  <circle cx="12" cy="12" r="10" fill="url(#${gid})"/>
  <path fill="#fff" d="M10 15.2 6.8 12l1.06-1.06L10 13.06l5.44-5.44L16.5 9 10 15.2z"/>
</svg></span>`;
}

/**
 * Inline badge next to admin names (visual only; distinct from expert teal).
 * @param {string} uniqueSuffix - keeps gradient ids unique when many SVGs on one page
 * @param {number} [sizePx=22]
 */
function getAdminUserBadgeHtml(uniqueSuffix, sizePx) {
    const size = Number(sizePx) > 0 ? Number(sizePx) : 22;
    const safe = String(uniqueSuffix || 'id').replace(/[^a-zA-Z0-9_-]/g, '') || 'id';
    const gid = `admin-user-grad-${safe}`;
    return `<span class="admin-user-badge" title="Administrator" aria-label="Administrator">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" class="admin-user-badge-svg" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="${gid}" x1="0%" y1="100%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#636e72"/>
      <stop offset="100%" stop-color="#2d3436"/>
    </linearGradient>
  </defs>
  <path fill="url(#${gid})" d="M12 2 4 5v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V5l-8-3Zm0 2.2 6 2.25V11c0 3.8-2.5 7.2-6 8.6-3.5-1.4-6-4.8-6-8.6V6.45l6-2.25Z"/>
  <path fill="#dfe6e9" d="M11 14h2v2h-2zm0-6h2v5h-2z"/>
</svg></span>`;
}

/**
 * User IDs listed in public.admins. Badges and nav use this with users.is_admin
 * (some accounts are admins via roster only).
 */
async function fetchAdminUserIdsSet(supabase) {
    const set = new Set();
    if (!supabase) return set;
    try {
        const { data, error } = await supabase.from('admins').select('user_id');
        if (error) {
            console.warn('fetchAdminUserIdsSet:', error.message || error);
            return set;
        }
        (data || []).forEach((row) => {
            if (row.user_id) set.add(row.user_id);
        });
    } catch (e) {
        console.warn('fetchAdminUserIdsSet:', e?.message || e);
    }
    return set;
}

/** True if the user should show admin UI: users.is_admin and/or public.admins roster. */
function mergeIsAdminFlag(userId, usersRowIsAdmin, adminIdSet) {
    if (usersRowIsAdmin) return true;
    if (!userId || !adminIdSet) return false;
    return adminIdSet.has(userId);
}

/**
 * Row shown on a post that an expert has endorsed.
 */
function getPostExpertApprovedBadgeHtml(uniqueSuffix) {
    const safe = String(uniqueSuffix || 'id').replace(/[^a-zA-Z0-9_-]/g, '') || 'id';
    const gid = `expert-post-grad-${safe}`;
    return `<div class="post-expert-endorsed-strip" role="status" aria-label="Expert approved post">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" class="post-expert-endorsed-icon" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="${gid}" x1="0%" y1="100%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#1dd1a1"/>
      <stop offset="100%" stop-color="#0984e3"/>
    </linearGradient>
  </defs>
  <circle cx="12" cy="12" r="10" fill="url(#${gid})"/>
  <path fill="#fff" d="M10 15.2 6.8 12l1.06-1.06L10 13.06l5.44-5.44L16.5 9 10 15.2z"/>
</svg>
<span class="post-expert-endorsed-label">Expert approved</span>
</div>`;
}

/**
 * Expert endorses another user's post (once per post; weekly cap).
 * @returns {Promise<{ ok: boolean, error?: string, weeklyRemaining?: number }>}
 */
async function tryExpertEndorsePost(supabase, { expertUserId, postId, postOwnerId }) {
    const limit = getExpertWeeklyEndorsementLimit();
    if (!supabase || !expertUserId || !postId) {
        return { ok: false, error: 'Missing data. Please refresh and try again.' };
    }
    if (postOwnerId && postOwnerId === expertUserId) {
        return { ok: false, error: 'You cannot endorse your own post.' };
    }

    const { data: expertRow, error: expertErr } = await supabase
        .from('users')
        .select('is_expert')
        .eq('id', expertUserId)
        .maybeSingle();
    if (expertErr) {
        return { ok: false, error: expertErr.message || 'Could not verify expert status.' };
    }
    if (!expertRow?.is_expert) {
        return { ok: false, error: 'Only approved wellness experts can award this badge.' };
    }

    const { data: post, error: postErr } = await supabase
        .from('posts')
        .select('id, user_id, expert_endorsed_at')
        .eq('id', postId)
        .maybeSingle();
    if (postErr) {
        if (/expert_endorsed|column|schema/i.test(String(postErr.message || ''))) {
            return {
                ok: false,
                error: 'Expert endorsements are not set up yet. Run SQL/009_expert_post_endorsement.sql in Supabase.'
            };
        }
        return { ok: false, error: postErr.message || 'Could not load post.' };
    }
    if (!post) {
        return { ok: false, error: 'Post not found.' };
    }
    if (post.user_id === expertUserId) {
        return { ok: false, error: 'You cannot endorse your own post.' };
    }
    if (post.expert_endorsed_at) {
        return { ok: false, error: 'This post already has an expert approval badge.' };
    }

    const usedBefore = await countExpertEndorsementsThisWeek(supabase, expertUserId);
    if (usedBefore >= limit) {
        return {
            ok: false,
            error: `You can endorse up to ${limit} posts per week. The limit resets every Monday.`,
            weeklyRemaining: 0
        };
    }

    const nowIso = new Date().toISOString();
    const { year, week_number } = getExpertGiftWeekFields(new Date());

    const { data: badgeRow, error: badgeErr } = await supabase
        .from('expert_badge_user')
        .insert({
            expert_user_id: expertUserId,
            post_id: postId,
            week_number,
            year,
            gifted_at: nowIso
        })
        .select('id')
        .maybeSingle();

    if (badgeErr) {
        if (/expert_badge_user|column|schema|relation/i.test(String(badgeErr.message || ''))) {
            return {
                ok: false,
                error: 'Expert badge table is not ready. Run SQL/010_expert_badge_user_constraints.sql (and ensure expert_badge_user exists).'
            };
        }
        if (isUniqueViolationError(badgeErr)) {
            return {
                ok: false,
                error: 'This post already has an expert approval badge.'
            };
        }
        return { ok: false, error: badgeErr.message || 'Could not record expert badge.' };
    }

    const badgeId = badgeRow?.id;
    const usedAfterInsert = await countExpertEndorsementsThisWeek(supabase, expertUserId);
    if (usedAfterInsert > limit && badgeId) {
        await supabase.from('expert_badge_user').delete().eq('id', badgeId);
        return {
            ok: false,
            error: `You can endorse up to ${limit} posts per week. The limit resets every Monday.`,
            weeklyRemaining: 0
        };
    }

    const updatePayload = {
        expert_endorsed_at: nowIso,
        expert_endorsed_by: expertUserId,
        is_expert_approved: true
    };

    let { error: upErr } = await supabase
        .from('posts')
        .update(updatePayload)
        .eq('id', postId)
        .is('expert_endorsed_at', null);

    if (upErr && /is_expert_approved|column|schema/i.test(String(upErr.message || ''))) {
        ({ error: upErr } = await supabase
            .from('posts')
            .update({
                expert_endorsed_at: nowIso,
                expert_endorsed_by: expertUserId
            })
            .eq('id', postId)
            .is('expert_endorsed_at', null));
    }

    if (upErr) {
        if (badgeId) {
            await supabase.from('expert_badge_user').delete().eq('id', badgeId);
        }
        if (/expert_endorsed|column|schema|permission|policy|rls/i.test(String(upErr.message || ''))) {
            return {
                ok: false,
                error:
                    'Could not save endorsement on the post. Experts need an UPDATE policy on public.posts — '
                    + 'run SQL/018_posts_expert_endorse_update_rls.sql in Supabase, then try again.'
            };
        }
        return { ok: false, error: upErr.message || 'Could not save endorsement.' };
    }

    const newUsed = usedAfterInsert;
    const ownerId = postOwnerId || post.user_id;
    if (ownerId && ownerId !== expertUserId) {
        try {
            const { data: en } = await supabase
                .from('users')
                .select('full_name, username')
                .eq('id', expertUserId)
                .maybeSingle();
            const expertName = en?.full_name || en?.username || 'A wellness expert';
            const row = {
                user_id: ownerId,
                actor_id: expertUserId,
                type: 'expert_post_badge',
                title: 'Your post was expert-approved',
                message: `${expertName} awarded the Expert approved badge to your post.`,
                is_read: false,
                post_id: postId
            };
            if (typeof insertNotificationRow === 'function') {
                await insertNotificationRow(supabase, row);
            } else {
                await supabase.from('notifications').insert(row);
            }
        } catch (n) {
            console.warn('Expert badge owner notification skipped:', n?.message || n);
        }
    }

    return { ok: true, weeklyRemaining: Math.max(0, limit - newUsed) };
}

/**
 * Expert removes a badge they awarded on a post.
 * Prefers the gcfs_remove_expert_badge RPC (SQL/013); falls back to
 * direct DELETE + UPDATE if the RPC is not installed yet.
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function tryExpertRemovePostBadge(supabase, { expertUserId, postId }) {
    if (!supabase || !expertUserId || !postId) {
        return { ok: false, error: 'Missing data. Please refresh and try again.' };
    }

    // Preferred path: single RPC (needs SQL/013_admin_expert_rpc.sql)
    const { error: rpcErr } = await supabase.rpc('gcfs_remove_expert_badge', { p_post_id: postId });
    if (!rpcErr) return { ok: true };

    const rpcMissing = /function|routine|does not exist|schema cache/i.test(String(rpcErr.message || ''));
    if (!rpcMissing) {
        return { ok: false, error: rpcErr.message || 'Could not remove the expert badge.' };
    }

    // Fallback: manual delete + post update (needs DELETE policy on expert_badge_user
    // and UPDATE policy on posts — see SQL/013)
    const { data: badge, error: badgeErr } = await supabase
        .from('expert_badge_user')
        .select('id')
        .eq('post_id', postId)
        .eq('expert_user_id', expertUserId)
        .maybeSingle();

    if (badgeErr) {
        return { ok: false, error: badgeErr.message || 'Could not find the badge record.' };
    }
    if (!badge?.id) {
        return { ok: false, error: 'You did not award an expert badge on this post.' };
    }

    const { error: delErr } = await supabase.from('expert_badge_user').delete().eq('id', badge.id);
    if (delErr) {
        return {
            ok: false,
            error: 'Could not remove the badge record — run SQL/013_admin_expert_rpc.sql in Supabase, then try again.'
        };
    }

    const { error: upErr } = await supabase
        .from('posts')
        .update({ expert_endorsed_at: null, expert_endorsed_by: null, is_expert_approved: false })
        .eq('id', postId);

    if (upErr) {
        console.warn('Badge removed but post fields not cleared:', upErr.message || upErr);
        // Badge row is gone; the strip may still show until refresh — still report success-ish
        return { ok: true, warning: 'Badge record removed; post badge may need a refresh.' };
    }

    return { ok: true };
}

async function notifyAllAdmins({ type, title, message }) {
    try {
        const sb = getSupabaseClient();
        if (!sb) return;

        let { data: admins, error } = await sb.from('admins').select('user_id');
        if (error) {
            console.warn('notifyAllAdmins admins select:', error.message || error);
        }
        if (!admins?.length) {
            const alt = await sb.from('users').select('id').eq('is_admin', true);
            if (!alt.error && alt.data?.length) {
                admins = alt.data.map((u) => ({ user_id: u.id }));
            }
        }
        if (!admins?.length) {
            console.warn('notifyAllAdmins: no admin recipients (add rows to public.admins or set users.is_admin).');
            return;
        }

        const rows = admins.map((a) => ({
            user_id: a.user_id,
            actor_id: null,
            type: type || 'admin',
            title: title || 'Admin notice',
            message: message || '',
            is_read: false
        }));

        const { error: insErr } = await sb.from('notifications').insert(rows);
        if (insErr) throw insErr;
    } catch (e) {
        console.warn('notifyAllAdmins skipped:', e?.message || e);
    }
}

/**
 * Merge expert endorsement fields from SECURITY DEFINER RPC so every signed-in user sees the same
 * Expert approved strip (fixes RLS masking endorsement columns on direct posts selects).
 */
async function mergePostsExpertBadgeFromRpc(supabaseClient, posts) {
    try {
        if (!supabaseClient?.rpc || !posts?.length) return;
        const ids = [...new Set(posts.map((p) => p?.id).filter(Boolean))];
        if (!ids.length) return;
        const { data, error } = await supabaseClient.rpc('get_posts_expert_badge_columns', {
            p_ids: ids
        });
        if (error) {
            if (!/rpc|function|schema|permission|could not find/i.test(String(error.message || ''))) {
                console.warn('mergePostsExpertBadgeFromRpc:', error.message || error);
            }
            return;
        }
        if (!data?.length) return;
        const byId = new Map(data.map((r) => [r.post_id, r]));
        posts.forEach((p) => {
            const row = byId.get(p?.id);
            if (!row) return;
            if (row.expert_endorsed_at != null && row.expert_endorsed_at !== '') {
                p.expert_endorsed_at = row.expert_endorsed_at;
            }
            if (row.expert_endorsed_by != null) {
                p.expert_endorsed_by = row.expert_endorsed_by;
            }
            if (row.is_expert_approved != null) {
                p.is_expert_approved = !!row.is_expert_approved;
            }
        });
    } catch (e) {
        console.warn('mergePostsExpertBadgeFromRpc skipped:', e?.message || e);
    }
}

/**
 * Like notifications only — skip if the same actor liked the same post for this recipient recently (reduces duplicates).
 */
async function insertPostLikeNotificationDeduped(sb, row, dedupeMinutes = 4) {
    if (!sb || !row?.user_id || !row?.actor_id || !row?.post_id) {
        return { error: new Error('Missing notification fields') };
    }
    const since = new Date(Date.now() - dedupeMinutes * 60 * 1000).toISOString();
    const { data: dup } = await sb
        .from('notifications')
        .select('id')
        .eq('user_id', row.user_id)
        .eq('actor_id', row.actor_id)
        .eq('post_id', row.post_id)
        .eq('type', 'post_like')
        .gte('created_at', since)
        .maybeSingle();
    if (dup?.id) return { error: null };
    return insertNotificationRow(sb, row);
}

/**
 * Insert one notification row; retries without post_id/comment_id if those columns are missing.
 */
async function insertNotificationRow(sb, row) {
    if (!sb) return { error: new Error('No Supabase client') };
    let res = await sb.from('notifications').insert(row);
    if (
        !res.error
        || !/post_id|comment_id|column|schema|Could not find/i.test(String(res.error.message || ''))
    ) {
        return res;
    }
    const { post_id: _p, comment_id: _c, ...rest } = row;
    return sb.from('notifications').insert(rest);
}
