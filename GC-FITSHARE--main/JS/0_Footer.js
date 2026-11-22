/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 0_Footer.js — GLOBAL CHROME (load after 0_Utilities.js on app pages)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PURPOSE
 *   Dark mode + Admin Verify modal + admin nav visibility cache + logout.
 *   showAppAlert() — use this instead of alert(); needs 0_Alerts.js (CustomAlert). 
 *
 * DEPENDS ON
 *   0_Utilities.js (getSupabaseClient, escapeHtml), 0_Alerts.js (CustomAlert).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ─── Dark Mode ────────────────────────────────────────────────────────────────

/**
 * Toggle dark mode on body and save preference to localStorage
 */
function toggleDarkMode() {
    document.body.classList.toggle('dark-mode');
    localStorage.setItem('gcfitshare_darkmode', document.body.classList.contains('dark-mode'));
    updateDarkModeIcon();
}

function showAppAlert(title, message, type = 'info') {
    if (typeof CustomAlert !== 'undefined' && typeof CustomAlert.show === 'function') {
        CustomAlert.show(title, message, type);
        return;
    }
    console.warn('[Alert]', title, message);
}

/**
 * Apply saved dark mode preference on page load.
 * Runs immediately so there's no flash of wrong theme.
 */
(function applyDarkModeOnLoad() {
    if (localStorage.getItem('gcfitshare_darkmode') === 'true') {
        document.body.classList.add('dark-mode');
    }
    if (typeof updateDarkModeIcon === 'function') updateDarkModeIcon();
})();

// ─── Admin Verify ─────────────────────────────────────────────────────────────

/** Human-readable admin level for the verification modal. */
function formatAdminVerifyLevel(level) {
    const raw = String(level || 'admin').toLowerCase().trim();
    const map = {
        super: 'Super admin',
        profile_flag: 'Admin (profile)',
        admin: 'Admin',
        regular: 'Admin'
    };
    if (map[raw]) return map[raw];
    return raw.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function adminVerifyEsc(text) {
    if (typeof escapeHtml === 'function') return escapeHtml(String(text ?? ''));
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
}

/**
 * Check if the current user is an admin by looking up the admins table.
 * Shows a modal with their admin status.
 * Requires: supabase client + currentUser to be set on the page.
 */
async function verifyAdminStatus() {
    const modal  = document.getElementById('adminVerificationModal');
    const status = document.getElementById('adminVerificationStatus');
    const hasModal = !!(modal && status);

    if (hasModal) {
        // Show modal with loading state
        modal.classList.remove('hidden');
        status.innerHTML = `
            <div class="verify-loading">
                <div class="verify-spinner"></div>
                <p>Checking your admin status...</p>
            </div>`;
    }

    try {
        // supabase and currentUser must be declared on the page
        if (typeof supabase === 'undefined') {
            if (hasModal) {
                status.innerHTML = `<div class="verify-error" role="alert">Could not connect to the app. Refresh and try again.</div>`;
            }
            return;
        }

        let userId = currentUser?.id || null;
        if (!userId) {
            const { data: authData } = await supabase.auth.getUser();
            userId = authData?.user?.id || null;
        }
        if (!userId) {
            if (hasModal) {
                status.innerHTML = `<div class="verify-error" role="alert">Sign in to verify admin access.</div>`;
            }
            return;
        }

        let { data, error } = await supabase
            .from('admins')
            .select('admin_level, can_approve_experts, can_delete_posts, can_suspend_users, assigned_at')
            .eq('user_id', userId)
            .maybeSingle();

        if (error || !data) {
            const { data: uadm, error: uerr } = await supabase
                .from('users')
                .select('is_admin')
                .eq('id', userId)
                .maybeSingle();
            if (!uerr && uadm?.is_admin) {
                data = {
                    admin_level: 'profile_flag',
                    can_approve_experts: true,
                    can_delete_posts: true,
                    can_suspend_users: true,
                    assigned_at: new Date().toISOString()
                };
                error = null;
            }
        }

        if (error || !data) {
            setAdminNavVisible(false);
            cacheAdminNavVisibility(false, userId);
            if (hasModal) {
                status.innerHTML = `
                    <div class="verify-result verify-result--fail not-admin" role="status">
                        <div class="verify-badge-icon" aria-hidden="true">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="28" height="28">
                                <circle cx="12" cy="12" r="10"/>
                                <path d="m15 9-6 6M9 9l6 6"/>
                            </svg>
                        </div>
                        <p class="verify-result-kicker">Access check</p>
                        <h3 class="verify-result-title">Not an administrator</h3>
                        <p class="verify-hint">Your account is not in the admins list. Contact a super admin if you need dashboard access.</p>
                    </div>`;
            } else {
                showAppAlert('Access Denied', 'You are not an Admin.', 'error');
            }
            return;
        }

        const assignedAt = data.assigned_at ? new Date(data.assigned_at) : null;
        const since =
            assignedAt && !Number.isNaN(assignedAt.getTime())
                ? assignedAt.toLocaleDateString('en-US', {
                      month: 'long',
                      day: 'numeric',
                      year: 'numeric'
                  })
                : '—';

        const permYes = (on) => (on
            ? '<span class="admin-verify-chip admin-verify-chip--yes">Yes</span>'
            : '<span class="admin-verify-chip admin-verify-chip--no">No</span>');

        if (hasModal) {
            const levelText = adminVerifyEsc(formatAdminVerifyLevel(data.admin_level));
            const assignedText = adminVerifyEsc(since);
            status.innerHTML = `
                <div class="verify-result verify-result--success is-admin" role="status">
                    <div class="verify-badge-icon" aria-hidden="true">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                            <polyline points="22 4 12 14.01 9 11.01"/>
                        </svg>
                    </div>
                    <p class="verify-result-kicker">Verified</p>
                    <h3 class="verify-result-title">Administrator</h3>
                    <dl class="admin-verify-spec">
                        <div class="admin-verify-spec__row">
                            <dt>Access level</dt>
                            <dd>${levelText}</dd>
                        </div>
                        <div class="admin-verify-spec__row">
                            <dt>Approve experts</dt>
                            <dd>${permYes(!!data.can_approve_experts)}</dd>
                        </div>
                        <div class="admin-verify-spec__row">
                            <dt>Delete posts</dt>
                            <dd>${permYes(!!data.can_delete_posts)}</dd>
                        </div>
                        <div class="admin-verify-spec__row">
                            <dt>Suspend users</dt>
                            <dd>${permYes(!!data.can_suspend_users)}</dd>
                        </div>
                        <div class="admin-verify-spec__row">
                            <dt>Assigned</dt>
                            <dd>${assignedText}</dd>
                        </div>
                    </dl>
                </div>`;
        } else {
            showAppAlert('Admin Verified', 'Admin verified. Admin Dashboard is now available in the sidebar.', 'success');
        }
        setAdminNavVisible(true);
        cacheAdminNavVisibility(true, userId);
    } catch (err) {
        console.error('Admin verify error:', err);
        if (hasModal) {
            status.innerHTML = `<div class="verify-error" role="alert">Could not verify admin status. Check your connection and try again.</div>`;
        }
    }
}

function setAdminNavVisible(isVisible) {
    document.querySelectorAll('.admin-only-nav').forEach((el) => {
        el.style.display = isVisible ? 'flex' : 'none';
    });
}

/** Legacy key (no user id) — do not use for reads; cleared when writing per-user cache */
const LEGACY_ADMIN_NAV_CACHE_KEY = 'gcfitshare_admin_nav_visible';
const ADMIN_NAV_CACHE_PREFIX = 'gcfitshare_admin_nav_visible';

function adminNavCacheKey(userId) {
    if (!userId) return LEGACY_ADMIN_NAV_CACHE_KEY;
    return `${ADMIN_NAV_CACHE_PREFIX}:${userId}`;
}

function cacheAdminNavVisibility(isVisible, userId) {
    try {
        if (userId) {
            localStorage.setItem(adminNavCacheKey(userId), isVisible ? 'true' : 'false');
        }
        localStorage.removeItem(LEGACY_ADMIN_NAV_CACHE_KEY);
    } catch {
        // Ignore storage failures; hydration still reconciles final state.
    }
}

function getCachedAdminNavVisibility(userId) {
    if (!userId) return null;
    try {
        const cached = localStorage.getItem(adminNavCacheKey(userId));
        if (cached === 'true') return true;
        if (cached === 'false') return false;
    } catch {
        // ignore
    }
    return null;
}

/**
 * Read Supabase session from localStorage (sync) so we can scope admin-nav cache per user.
 */
function tryGetSessionUserIdSync() {
    try {
        const keys = Object.keys(localStorage);
        for (const k of keys) {
            if (!k.includes('-auth-token')) continue;
            const raw = localStorage.getItem(k);
            if (!raw) continue;
            const parsed = JSON.parse(raw);
            const uid = parsed?.user?.id || parsed?.currentSession?.user?.id;
            if (uid) return uid;
        }
    } catch {
        // ignore
    }
    return null;
}

function clearAllAdminNavVisibilityCaches() {
    try {
        const keys = Object.keys(localStorage);
        for (const k of keys) {
            if (k === LEGACY_ADMIN_NAV_CACHE_KEY || k.startsWith(`${ADMIN_NAV_CACHE_PREFIX}:`)) {
                localStorage.removeItem(k);
            }
        }
    } catch {
        // ignore
    }
}

function isAdminDashboardPage() {
    const path = window.location.pathname || '';
    return /\/HTML\/6_Admin_Dashboard\.html$/i.test(path) || /6_Admin_Dashboard\.html$/i.test(path);
}

function initializeAdminNavVisibility() {
    if (isAdminDashboardPage()) {
        setAdminNavVisible(true);
        return;
    }
    const uid = tryGetSessionUserIdSync();
    if (uid && getCachedAdminNavVisibility(uid) === true) {
        setAdminNavVisible(true);
        return;
    }
    setAdminNavVisible(false);
}

async function hydrateAdminNavVisibility() {
    try {
        const client = typeof getSupabaseClient === 'function' ? getSupabaseClient() : null;
        if (!client) {
            return;
        }

        let userId = null;
        let authError = null;

        // Retry once to avoid temporary auth-read race conditions on page switches.
        for (let attempt = 0; attempt < 2; attempt++) {
            const { data: authData, error } = await client.auth.getUser();
            if (!error && authData?.user?.id) {
                userId = authData.user.id;
                authError = null;
                break;
            }
            authError = error || null;
            await new Promise((resolve) => setTimeout(resolve, 150));
        }

        // Fallback: session can be available even when getUser() is briefly empty.
        if (!userId) {
            const { data: sessionData } = await client.auth.getSession();
            userId = sessionData?.session?.user?.id || null;
        }

        if (!userId) {
            if (authError) {
                console.warn('Admin nav hydration auth skipped:', authError?.message || authError);
                return;
            }
            setAdminNavVisible(false);
            return;
        }

        const { data, error } = await client
            .from('admins')
            .select('id')
            .eq('user_id', userId)
            .maybeSingle();

        if (error) {
            console.warn('Admin nav hydration query skipped:', error?.message || error);
            setAdminNavVisible(false);
            return;
        }

        if (!data) {
            const { data: urow, error: uerr } = await client
                .from('users')
                .select('is_admin')
                .eq('id', userId)
                .maybeSingle();
            if (!uerr && urow?.is_admin) {
                setAdminNavVisible(true);
                cacheAdminNavVisibility(true, userId);
                return;
            }
            setAdminNavVisible(false);
            cacheAdminNavVisibility(false, userId);
            return;
        }

        setAdminNavVisible(true);
        cacheAdminNavVisibility(true, userId);
    } catch (err) {
        console.warn('Admin nav hydration skipped:', err?.message || err);
        setAdminNavVisible(false);
    }
}

// Apply cached/known visibility immediately to minimize first-paint flicker.
initializeAdminNavVisibility();
hydrateAdminNavVisibility();

// ─── Logout ───────────────────────────────────────────────────────────────────

/**
 * Sign out the current user and redirect to the login page.
 * Requires: supabase client to be available on the page.
 */
async function handleLogout() {
    try {
        if (typeof supabase !== 'undefined') {
            await supabase.auth.signOut();
        }
    } catch (err) {
        console.error('Logout error:', err);
    } finally {
        clearAllAdminNavVisibilityCaches();
        // Always redirect even if signOut fails
        window.location.href = '/HTML/1_LogIn_Page.html';
    }
}

// ─── Attach Listeners on DOM Ready ───────────────────────────────────────────

/**
 * Wire up the 3 sidebar footer buttons.
 * Works on any page that has these button IDs.
 */
document.addEventListener('DOMContentLoaded', () => {
    // Dark mode toggle
    document.getElementById('darkModeToggle')
        ?.addEventListener('click', toggleDarkMode);

    // Admin verify button
    document.getElementById('adminVerifyBtn')
        ?.addEventListener('click', verifyAdminStatus);

    // Close admin modal (×)
    document.getElementById('closeAdminModal')
        ?.addEventListener('click', () => {
            document.getElementById('adminVerificationModal')?.classList.add('hidden');
        });

    // Close admin modal on backdrop click
    document.getElementById('adminVerificationModal')
        ?.addEventListener('click', (e) => {
            if (e.target.id === 'adminVerificationModal') {
                e.target.classList.add('hidden');
            }
        });

    // Logout button
    document.getElementById('logoutBtn')
        ?.addEventListener('click', handleLogout);

    // Ensure mobile backdrop overlay exists
    let overlay = document.getElementById('sidebarOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'sidebarOverlay';
        overlay.className = 'sidebar-overlay';
        document.body.appendChild(overlay);
    }

    const updateSidebarOverlay = () => {
        const sidebar = document.getElementById('sidebar');
        const toggle = document.getElementById('sidebarToggle');
        const isOpen = !!sidebar && !sidebar.classList.contains('hidden');
        toggle?.setAttribute('aria-expanded', String(isOpen));
        if (!sidebar || window.innerWidth > 1024) {
            overlay?.classList.remove('active');
            return;
        }
        if (!isOpen) {
            overlay?.classList.remove('active');
        } else {
            overlay?.classList.add('active');
        }
    };

    // Mobile sidebar layout sync: ensure sidebar starts closed on mobile devices
    const syncMobileSidebar = () => {
        const sidebar = document.getElementById('sidebar');
        if (!sidebar) return;
        if (window.innerWidth <= 1024) {
            if (!sidebar.dataset.userInteracted) {
                sidebar.classList.add('hidden');
            }
        } else {
            sidebar.classList.remove('hidden');
            delete sidebar.dataset.userInteracted;
        }
        updateSidebarOverlay();
    };
    syncMobileSidebar();
    window.addEventListener('resize', syncMobileSidebar);

    // Shared drawer control keeps all pages in sync, including Guidance.
    document.getElementById('sidebarToggle')?.addEventListener('click', () => {
        const sidebar = document.getElementById('sidebar');
        if (!sidebar) return;
        sidebar.dataset.userInteracted = 'true';
        sidebar.classList.toggle('hidden');
        updateSidebarOverlay();
    });

    // Close on overlay tap
    overlay.addEventListener('click', () => {
        const sidebar = document.getElementById('sidebar');
        if (sidebar) {
            sidebar.classList.add('hidden');
            sidebar.dataset.userInteracted = 'true';
        }
        document.getElementById('sidebarToggle')?.setAttribute('aria-expanded', 'false');
        overlay.classList.remove('active');
    });

    // Close sidebar on mobile when clicking outside
    document.addEventListener('click', (e) => {
        if (window.innerWidth > 1024) return;
        const sidebar = document.getElementById('sidebar');
        const toggle = document.getElementById('sidebarToggle');
        if (!sidebar || sidebar.classList.contains('hidden')) return;
        if (!sidebar.contains(e.target) && !toggle?.contains(e.target)) {
            sidebar.classList.add('hidden');
            sidebar.dataset.userInteracted = 'true';
            toggle?.setAttribute('aria-expanded', 'false');
            updateSidebarOverlay();
        }
    });

    // Observe sidebar class mutations so overlay always reflects state immediately
    const sidebarEl = document.getElementById('sidebar');
    if (sidebarEl && window.MutationObserver) {
        const observer = new MutationObserver(() => updateSidebarOverlay());
        observer.observe(sidebarEl, { attributes: true, attributeFilter: ['class'] });
    }
});
