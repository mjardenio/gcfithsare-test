/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 6_Admin_Dashboard.js — ADMIN CONSOLE (moderation, experts, flags) 
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PURPOSE
 *   Gate access via public.admins + users.is_admin; expert applications;   
 *   user-reported flags; AI moderation summary; suspend/ban; revoke expert.
 *
 * DEPENDS ON
 *   0_Utilities.js, 0_Footer.js, Supabase CDN; HTML gate #adminAccessGate.
 *
 * SECTIONS (search for these `// ───` headers)
 *   Page gate & layout | Auth read | Flag review modal | Expert review modal
 *   DOM setup | ensureAdminAccess | Expert lists | AI panel | Accordion
 *   loadAdminDashboard | Active experts / revoke | Flagged content & purge
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ─── State & caches ──────────────────────────────────────────────────────────

let supabase;
let currentUser;

const flaggedRowsById = new Map();
const expertApplicationsById = new Map();
const approvedExpertsById = new Map();
/** User-reported flags (not AI) older than this are purged on each admin dashboard load, and via SQL (see 012). */
const USER_REPORT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
let flagReviewContext = null;
let adminRecordId = null;
let expertReviewAppId = null;
let revokeExpertPendingUserId = null;

// ─── Page gate & mobile sidebar ──────────────────────────────────────────────

function hideAdminAccessGate() {
    document.getElementById('adminAccessGate')?.classList.add('hidden');
}

function applyAdminMobileSidebarDefaults() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar || !window.matchMedia) return;
    if (window.matchMedia('(max-width: 768px)').matches) {
        sidebar.classList.add('hidden');
    }
}

function syncAdminSidebarDesktopBreakpoint() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar || !window.matchMedia) return;
    if (window.matchMedia('(min-width: 769px)').matches) {
        sidebar.classList.remove('hidden');
    }
}

async function resolveAuthenticatedUser() {
    const client = (typeof getSupabaseClient === 'function') ? getSupabaseClient() : null;
    if (!client) return null;

    let user = null;
    let authError = null;

    for (let attempt = 0; attempt < 2; attempt++) {
        const { data, error } = await client.auth.getUser();
        if (!error && data?.user) {
            user = data.user;
            authError = null;
            break;
        }
        authError = error || null;
        await new Promise((resolve) => setTimeout(resolve, 150));
    }

    if (!user) {
        const { data: sessionData } = await client.auth.getSession();
        user = sessionData?.session?.user || null;
    }

    if (!user && authError) {
        console.warn('Admin auth read skipped:', authError?.message || authError);
    }
    return user;
}

// ─── User-reported posts: flag review modal & author moderation ─────────────

function closeFlagReviewModal() {
    const modal = document.getElementById('flaggedReviewModal');
    if (modal) modal.classList.add('hidden');
    flagReviewContext = null;
}

function setFlagModalLoading(msg) {
    const note = document.getElementById('flaggedReviewLoadNote');
    const content = document.getElementById('flaggedReviewContent');
    if (note) note.textContent = msg || '';
    if (content) {
        if (msg) {
            content.classList.add('hidden');
        } else {
            content.classList.remove('hidden');
        }
    }
}

/** User-reported queue: not AI flags, not closed as dismissed (hidden from list). */
function isUserReportModerationQueueRow(row) {
    if (!row) return false;
    if (String(row.flagged_by || '').toLowerCase().includes('ai')) return false;
    if (String(row.status || '').toLowerCase().trim() === 'dismissed') return false;
    return true;
}

function formatUserSuspensionLine(author) {
    if (!author) return '';
    if (!author.is_suspended) return 'Posting: allowed';
    if (author.suspended_until) {
        const t = new Date(author.suspended_until);
        if (!Number.isNaN(t.getTime()) && t.getTime() > Date.now()) {
            return `Suspended from posting until ${t.toLocaleString()}`;
        }
    }
    return 'Suspended from posting (indefinite ban)';
}

async function resolveReporterLabel(flaggedBy) {
    const raw = String(flaggedBy || 'unknown');
    if (!/^[0-9a-f-]{36}$/i.test(raw)) {
        if (String(raw).toLowerCase().includes('ai')) return 'AI moderation';
        return raw;
    }
    const { data, error } = await supabase
        .from('users')
        .select('username, full_name, email')
        .eq('id', raw)
        .maybeSingle();
    if (error || !data) return raw;
    return data.full_name || data.username || data.email || raw;
}

async function openFlagReviewModal(flagId) {
    const row = flaggedRowsById.get(flagId);
    if (!row) {
        showAppAlert('Review', 'This flag is no longer in the list. Refresh the page.', 'info');
        return;
    }

    setFlagModalLoading('Loading post and author…');
    const modal = document.getElementById('flaggedReviewModal');
    if (modal) modal.classList.remove('hidden');

    const { data: post, error: postErr } = await supabase
        .from('posts')
        .select('id, title, body, image_url, hashtags, category, user_id, created_at')
        .eq('id', row.post_id)
        .maybeSingle();

    if (postErr || !post) {
        flagReviewContext = { row, post: null, author: null };
        document.getElementById('flaggedReviewHeading').textContent = 'Review flag (post missing)';
        document.getElementById('flaggedReviewMeta').textContent =
            `Flag id: ${row.id} • Reported: ${formatDate(row.created_at)} • Current: ${row.status || 'pending'}`;
        document.getElementById('flaggedReviewPostTitle').textContent = '—';
        document.getElementById('flaggedReviewCategory').textContent = postErr
            ? `Could not load post: ${postErr.message}`
            : 'This post may have been deleted. You can still update flag status.';
        document.getElementById('flaggedReviewPostBody').textContent = '';
        document.getElementById('flaggedReviewImageWrap')?.classList.add('hidden');
        document.getElementById('flaggedReviewHashtags').style.display = 'none';
        document.getElementById('flaggedReviewAuthor').textContent = '—';
        document.getElementById('flaggedReviewAuthorStatus').textContent = '';
        document.getElementById('flaggedReviewReason').textContent = row.reason || 'No reason provided';
        const sel = document.getElementById('flagStatusSelect');
        if (sel) {
            const v = (row.status || 'pending').toLowerCase();
            const allowed = ['pending', 'in_review', 'resolved', 'dismissed'];
            sel.value = allowed.includes(v) ? v : 'pending';
        }
        document.getElementById('deletePostAdminBtn').disabled = true;
        document.getElementById('suspendUserBtn').disabled = true;
        document.getElementById('banUserBtn').disabled = true;
        document.getElementById('liftSuspensionBtn').disabled = true;
        setFlagModalLoading('');
        return;
    }

    document.getElementById('deletePostAdminBtn').disabled = false;
    document.getElementById('suspendUserBtn').disabled = false;
    document.getElementById('banUserBtn').disabled = false;
    document.getElementById('liftSuspensionBtn').disabled = false;

    const { data: author, error: authorErr } = await supabase
        .from('users')
        .select('id, username, full_name, email, is_suspended, suspended_until')
        .eq('id', post.user_id)
        .maybeSingle();

    if (authorErr) {
        console.warn('Author load:', authorErr);
    }

    const reporterLabel = await resolveReporterLabel(row.flagged_by);
    const isAi = String(row.flagged_by || '').toLowerCase().includes('ai');
    const heading = document.getElementById('flaggedReviewHeading');
    if (heading) {
        heading.textContent = isAi ? 'Review AI-flagged post' : 'Review user-reported post';
    }

    document.getElementById('flaggedReviewMeta').textContent =
        `Flag id: ${row.id} • Reported: ${formatDate(row.created_at)} • By: ${reporterLabel} • Current: ${row.status || 'pending'}`;

    document.getElementById('flaggedReviewPostTitle').textContent = post.title || 'Untitled';
    const catEl = document.getElementById('flaggedReviewCategory');
    if (catEl) {
        const bits = [post.category, post.created_at ? `Posted ${formatDate(post.created_at)}` : ''].filter(Boolean);
        catEl.textContent = bits.join(' · ');
    }

    const bodyEl = document.getElementById('flaggedReviewPostBody');
    if (bodyEl) {
        bodyEl.textContent = post.body && String(post.body).trim() ? post.body : '(No body text)';
    }

    const imgWrap = document.getElementById('flaggedReviewImageWrap');
    const img = document.getElementById('flaggedReviewImage');
    if (post.image_url && img && imgWrap) {
        img.src = post.image_url;
        img.alt = 'Post image';
        imgWrap.classList.remove('hidden');
    } else if (imgWrap) {
        imgWrap.classList.add('hidden');
    }

    const ht = document.getElementById('flaggedReviewHashtags');
    if (ht) {
        ht.textContent = post.hashtags ? String(post.hashtags).trim() : '';
        ht.style.display = post.hashtags ? 'block' : 'none';
    }

    const authorLine = author
        ? `${author.full_name || author.username || 'User'} (${author.email || author.id})`
        : `User id: ${post.user_id}`;
    document.getElementById('flaggedReviewAuthor').textContent = authorLine;
    document.getElementById('flaggedReviewAuthorStatus').textContent = formatUserSuspensionLine(author || {});

    document.getElementById('flaggedReviewReason').textContent = row.reason || 'No reason provided';

    const sel = document.getElementById('flagStatusSelect');
    if (sel) {
        const v = (row.status || 'pending').toLowerCase();
        const allowed = ['pending', 'in_review', 'resolved', 'dismissed'];
        sel.value = allowed.includes(v) ? v : 'pending';
    }

    flagReviewContext = { row, post, author: author || { id: post.user_id } };
    setFlagModalLoading('');
}

async function saveFlagStatusFromModal() {
    if (!flagReviewContext?.row?.id) return;
    const status = document.getElementById('flagStatusSelect')?.value || 'pending';
    const { error } = await supabase
        .from('flagged_content')
        .update({ status })
        .eq('id', flagReviewContext.row.id);
    if (error) {
        showAppAlert('Update failed', error.message || 'Could not save status', 'error');
        return;
    }
    recordActivityAction('Post report marked '+status);
    flagReviewContext.row.status = status;
    showAppAlert('Saved', 'Flag status updated.', 'success');
    await loadAdminDashboard();
    closeFlagReviewModal();
}

async function adminDeletePostById(postId) {
    const { error } = await supabase.from('posts').delete().eq('id', postId);
    if (error) throw error;
}

async function deletePostFromModal() {
    if (!flagReviewContext?.post?.id) return;
    let proceed = true;
    if (typeof CustomAlert !== 'undefined' && typeof CustomAlert.confirm === 'function') {
        proceed = await CustomAlert.confirm(
            'Delete post',
            'Delete this post permanently? This cannot be undone.',
            { confirmText: 'Delete', cancelText: 'Cancel', danger: true }
        );
    } else if (typeof confirm === 'function') {
        proceed = confirm('Delete this post permanently? This cannot be undone.');
    }
    if (!proceed) return;
    try {
        await adminDeletePostById(flagReviewContext.post.id);
        recordActivityAction('Post deleted');
        showAppAlert('Deleted', 'The post was removed.', 'success');
        await loadAdminDashboard();
        closeFlagReviewModal();
    } catch (err) {
        showAppAlert('Delete failed', err?.message || String(err), 'error');
    }
}

async function suspendAuthorFromModal() {
    const authorId = flagReviewContext?.post?.user_id;
    if (!authorId) return;
    if (authorId === currentUser?.id) {
        showAppAlert('Not allowed', 'You cannot suspend your own account from here.', 'error');
        return;
    }
    const days = parseInt(document.getElementById('suspendDurationSelect')?.value || '7', 10);
    const until = new Date();
    until.setDate(until.getDate() + days);
    const { error } = await supabase
        .from('users')
        .update({ is_suspended: true, suspended_until: until.toISOString() })
        .eq('id', authorId);
    if (error) {
        showAppAlert('Suspend failed', error.message || 'Check database column suspended_until (see SQL/004_admin_moderation.sql).', 'error');
        return;
    }
    recordActivityAction('Posting suspended');
    showAppAlert('Suspended', `User cannot create new posts until ${until.toLocaleString()}.`, 'success');
    await openFlagReviewModal(flagReviewContext.row.id);
}

async function banAuthorFromModal() {
    const authorId = flagReviewContext?.post?.user_id;
    if (!authorId) return;
    if (authorId === currentUser?.id) {
        showAppAlert('Not allowed', 'You cannot ban your own account from here.', 'error');
        return;
    }
    let banProceed = true;
    if (typeof CustomAlert !== 'undefined' && typeof CustomAlert.confirm === 'function') {
        banProceed = await CustomAlert.confirm(
            'Ban from posting',
            'Ban this user from posting indefinitely? They can still browse unless you add more rules later.',
            { confirmText: 'Ban', cancelText: 'Cancel', danger: true }
        );
    } else if (typeof confirm === 'function') {
        banProceed = confirm('Ban this user from posting indefinitely? They can still browse unless you add more rules later.');
    }
    if (!banProceed) return;
    const { error } = await supabase
        .from('users')
        .update({ is_suspended: true, suspended_until: null })
        .eq('id', authorId);
    if (error) {
        showAppAlert('Ban failed', error.message || String(error), 'error');
        return;
    }
    recordActivityAction('Posting ban applied');
    showAppAlert('Banned', 'User is blocked from creating new posts.', 'success');
    await openFlagReviewModal(flagReviewContext.row.id);
}

async function liftAuthorFromModal() {
    const authorId = flagReviewContext?.post?.user_id;
    if (!authorId) return;
    let liftProceed = true;
    if (typeof CustomAlert !== 'undefined' && typeof CustomAlert.confirm === 'function') {
        liftProceed = await CustomAlert.confirm(
            'Lift suspension',
            'Lift posting suspension / ban for this user?',
            { confirmText: 'Lift ban', cancelText: 'Cancel' }
        );
    } else if (typeof confirm === 'function') {
        liftProceed = confirm('Lift posting suspension / ban for this user?');
    }
    if (!liftProceed) return;
    let error = null;
    ({ error } = await supabase
        .from('users')
        .update({ is_suspended: false, suspended_until: null })
        .eq('id', authorId));
    if (error && /suspended_until|column/i.test(String(error.message || ''))) {
        ({ error } = await supabase.from('users').update({ is_suspended: false }).eq('id', authorId));
    }
    if (error) {
        showAppAlert('Update failed', error.message || String(error), 'error');
        return;
    }
    recordActivityAction('Posting suspension lifted');
    showAppAlert('OK', 'User may create posts again (if no other blocks apply).', 'success');
    await openFlagReviewModal(flagReviewContext.row.id);
}

// ─── Expert application: approve / reject modal ─────────────────────────────

function closeExpertReviewModal() {
    document.getElementById('expertReviewModal')?.classList.add('hidden');
    expertReviewAppId = null;
    const ta = document.getElementById('expertDecisionNote');
    if (ta) ta.value = '';
}

function openExpertReviewModal(appId) {
    const app = expertApplicationsById.get(appId);
    if (!app) {
        showAppAlert('Application', 'Could not load this application. Refresh the page.', 'info');
        return;
    }
    expertReviewAppId = appId;
    const noteEl = document.getElementById('expertDecisionNote');
    if (noteEl) noteEl.value = '';
    const meta = `${escapeHtml(app.full_name || 'Applicant')} · ${escapeHtml(app.course || '—')} · Submitted: ${app.submitted_at ? formatDate(app.submitted_at) : '—'}`;
    document.getElementById('expertReviewMeta').textContent = meta;
    document.getElementById('expertReviewWhy').textContent = expertWhyText(app) || '—';
    document.getElementById('expertReviewCredentials').textContent = String(app.credentials || 'Not provided');
    const st = String(app.status || 'pending').toLowerCase();
    const pending = st === 'pending';
    document.getElementById('expertReviewStatusLine').textContent = pending
        ? 'Status: pending review.'
        : `Status: ${escapeHtml(app.status || '')} — decisions are final from this screen (refresh list after changes).`;
    const actions = document.getElementById('expertReviewActions');
    if (actions) actions.style.display = pending ? 'flex' : 'none';
    const noteWrap = document.getElementById('expertDecisionNoteWrap');
    if (noteWrap) noteWrap.style.display = pending ? 'block' : 'none';
    document.getElementById('expertReviewModal').classList.remove('hidden');
}

function buildExpertDecisionNotificationMessage(approved, noteRaw) {
    const note = (noteRaw || '').trim();
    const base = approved
        ? 'Congratulations! Your wellness expert application was approved. Thank you for contributing to GC FitShare.'
        : 'Your expert application was not approved at this time. You may apply again later if your qualifications change.';
    if (!note) return base;
    return `${base}\n\nMessage from the team:\n${note}`;
}

async function finalizeExpertApplication(appId, approved) {
    const app = expertApplicationsById.get(appId);
    if (!app) {
        showAppAlert('Error', 'Missing application.', 'error');
        return;
    }
    if (!adminRecordId) {
        const { data: selfAdm, error: selfErr } = await supabase
            .from('users')
            .select('is_admin')
            .eq('id', currentUser.id)
            .maybeSingle();
        if (selfErr || !selfAdm?.is_admin) {
            showAppAlert(
                'Error',
                'Missing admin reviewer id. Add your user to public.admins in Supabase, or ensure users.is_admin is set.',
                'error'
            );
            return;
        }
    }
    const st = String(app.status || 'pending').toLowerCase();
    if (st !== 'pending') {
        showAppAlert('Already decided', 'This application is no longer pending.', 'info');
        return;
    }

    let noteToApplicant = '';
    if (appId === expertReviewAppId) {
        noteToApplicant = (document.getElementById('expertDecisionNote')?.value || '').trim();
    }

    if (approved) {
        let okApprove = true;
        if (typeof CustomAlert !== 'undefined' && typeof CustomAlert.confirm === 'function') {
            okApprove = await CustomAlert.confirm(
                'Approve expert',
                'Approve this applicant as a wellness expert? They will get an in-app notification.',
                { confirmText: 'Approve', cancelText: 'Cancel' }
            );
        } else if (typeof confirm === 'function') {
            okApprove = confirm('Approve this applicant as a wellness expert? They will get an in-app notification.');
        }
        if (!okApprove) return;
    } else {
        let okReject = true;
        if (typeof CustomAlert !== 'undefined' && typeof CustomAlert.confirm === 'function') {
            okReject = await CustomAlert.confirm(
                'Reject application',
                'Reject this application? The applicant will be notified.',
                { confirmText: 'Reject', cancelText: 'Cancel', danger: true }
            );
        } else if (typeof confirm === 'function') {
            okReject = confirm('Reject this application? The applicant will be notified.');
        }
        if (!okReject) return;
    }

    try {
        const updatePayload = {
            status: approved ? 'approved' : 'rejected'
        };
        if (adminRecordId) updatePayload.reviewed_by = adminRecordId;
        if (noteToApplicant) {
            updatePayload.decision_note = noteToApplicant;
        }

        if (approved) {
            if (!app.user_id) {
                throw new Error('Application is missing user_id — cannot set expert status.');
            }
            // Preferred: SECURITY DEFINER RPC (SQL/013). Fallback: direct update (needs SQL/011 policies).
            let { error: euErr } = await supabase.rpc('gcfs_admin_grant_expert', { p_user_id: app.user_id });
            const grantMissing = euErr && /function|routine|does not exist|schema cache/i.test(String(euErr.message || ''));
            if (grantMissing) {
                ({ error: euErr } = await supabase
                    .from('users')
                    .update({ is_expert: true })
                    .eq('id', app.user_id));
            }
            if (euErr) {
                showAppAlert(
                    'Expert status blocked (database)',
                    'Could not set users.is_expert — Row Level Security is blocking the update.\n\n'
                        + 'Run SQL/013_admin_expert_rpc.sql in the Supabase SQL Editor, then approve again.\n\n'
                        + `Details: ${euErr.message || euErr}`,
                    'error'
                );
                return;
            }
        }

        let { error: uErr } = await supabase
            .from('expert_applications')
            .update(updatePayload)
            .eq('id', appId);

        if (uErr && noteToApplicant && /decision_note|column/i.test(String(uErr.message || ''))) {
            delete updatePayload.decision_note;
            ({ error: uErr } = await supabase.from('expert_applications').update(updatePayload).eq('id', appId));
            console.warn('decision_note column missing — add SQL/008_expert_decision_note.sql. Note still sent in notification.');
        }
        if (uErr) {
            if (approved && app.user_id) {
                await supabase.rpc('gcfs_admin_revoke_expert', { p_user_id: app.user_id })
                    .then(() => {}, () => supabase.from('users').update({ is_expert: false }).eq('id', app.user_id));
            }
            throw uErr;
        }

        recordActivityAction(approved ? 'Expert application approved' : 'Expert application rejected');
        const message = buildExpertDecisionNotificationMessage(approved, noteToApplicant);

        const { error: nErr } = await supabase.from('notifications').insert({
            user_id: app.user_id,
            actor_id: currentUser.id,
            type: 'expert_application_result',
            title: approved ? 'Expert application approved' : 'Expert application decision',
            message,
            is_read: false
        });
        if (nErr) console.warn('Applicant notification:', nErr.message || nErr);

        showAppAlert(
            approved ? 'Approved' : 'Rejected',
            approved
                ? 'The user is now marked as a wellness expert (is_expert) and has been notified in-app.'
                : 'The applicant has been notified in-app.',
            'success'
        );
        closeExpertReviewModal();
        await loadAdminDashboard();
    } catch (err) {
        showAppAlert('Update failed', err?.message || String(err), 'error');
    }
}

// ─── Bind modal buttons & delegated dashboard clicks ─────────────────────────

function setupExpertReviewModalEvents() {
    document.getElementById('closeExpertReviewModal')?.addEventListener('click', closeExpertReviewModal);
    document.getElementById('expertReviewModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'expertReviewModal') closeExpertReviewModal();
    });
    document.getElementById('expertApproveBtn')?.addEventListener('click', () => {
        if (expertReviewAppId) finalizeExpertApplication(expertReviewAppId, true);
    });
    document.getElementById('expertRejectBtn')?.addEventListener('click', () => {
        if (expertReviewAppId) finalizeExpertApplication(expertReviewAppId, false);
    });
}

function setupFlagReviewModalEvents() {
    document.getElementById('closeFlaggedReviewModal')?.addEventListener('click', closeFlagReviewModal);
    document.getElementById('flaggedReviewModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'flaggedReviewModal') closeFlagReviewModal();
    });
    document.getElementById('saveFlagStatusBtn')?.addEventListener('click', saveFlagStatusFromModal);
    document.getElementById('deletePostAdminBtn')?.addEventListener('click', deletePostFromModal);
    document.getElementById('suspendUserBtn')?.addEventListener('click', suspendAuthorFromModal);
    document.getElementById('banUserBtn')?.addEventListener('click', banAuthorFromModal);
    document.getElementById('liftSuspensionBtn')?.addEventListener('click', liftAuthorFromModal);

    document.addEventListener('click', (e) => {
        const view = e.target.closest('.btn-expert-view');
        if (view) {
            openExpertReviewModal(view.getAttribute('data-app-id'));
            return;
        }
        const btn = e.target.closest('.btn-review-flag');
        if (!btn) return;
        const fid = btn.getAttribute('data-flag-id');
        if (fid) openFlagReviewModal(fid);
    });
}

// ─── App entry (DOM ready) ───────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    const uidEarly = typeof tryGetSessionUserIdSync === 'function' ? tryGetSessionUserIdSync() : null;
    const showFromCache = uidEarly && typeof getCachedAdminNavVisibility === 'function' && getCachedAdminNavVisibility(uidEarly) === true;
    if (showFromCache) hideAdminAccessGate();

    setupExpertReviewModalEvents();
    setupFlagReviewModalEvents();
    setupRevokeExpertModalEvents();
    setupActiveExpertDetailModal();
    // Initialize admin tool cards
    try {
        initAdminToolCards();
    } catch (error) {
        console.warn('Admin tool cards initialization failed:', error);
    }
    try {
        supabase = (typeof getSupabaseClient === 'function') ? getSupabaseClient() : null;

        if (!supabase) {
            for (let i = 0; i < 8 && !supabase; i++) {
                await new Promise((resolve) => setTimeout(resolve, 150));
                supabase = (typeof getSupabaseClient === 'function') ? getSupabaseClient() : null;
            }
        }

        currentUser = await resolveAuthenticatedUser();
        if (!supabase || !currentUser) {
            window.location.href = '/HTML/1_LogIn_Page.html';
            return;
        }

        const isAdmin = await ensureAdminAccess();
        if (!isAdmin) return;
        initUserDirectory();
        initActivityControls();
        initStudentControls();
        initAdminExports();
        hideAdminAccessGate();
        applyAdminMobileSidebarDefaults();
        window.addEventListener('resize', syncAdminSidebarDesktopBreakpoint);

        await loadAdminDashboard();
    } catch (err) {
        console.error('Admin dashboard init failed:', err);
        showAppAlert('Admin Dashboard Error', 'Admin dashboard failed to load. Redirecting to Home.', 'error');
        window.location.href = '/HTML/2_Main_Feed.html';
    }
});

// ─── Admin access (admins table or users.is_admin) ───────────────────────────

async function ensureAdminAccess() {
    try {
        const { data, error } = await supabase
            .from('admins')
            .select('id')
            .eq('user_id', currentUser.id)
            .maybeSingle();

        if (!error && data?.id) {
            adminRecordId = data.id;
            cacheAdminNavVisibility(true, currentUser.id);
            return true;
        }

        const { data: urow, error: uerr } = await supabase
            .from('users')
            .select('is_admin')
            .eq('id', currentUser.id)
            .maybeSingle();

        if (!uerr && urow?.is_admin) {
            adminRecordId = null;
            cacheAdminNavVisibility(true, currentUser.id);
            return true;
        }

        adminRecordId = null;
        cacheAdminNavVisibility(false, currentUser.id);
        showAppAlert('Access Denied', 'Access denied. Admin only.', 'error');
        window.location.href = '/HTML/2_Main_Feed.html';
        return false;
    } catch (_err) {
        adminRecordId = null;
        cacheAdminNavVisibility(false, currentUser?.id);
        showAppAlert('Verification Failed', 'Unable to verify admin access.', 'error');
        window.location.href = '/HTML/2_Main_Feed.html';
        return false;
    }
}

// ─── Expert application queue: list UI ───────────────────────────────────────

function expertWhyText(row) {
    const v = row.field_of_expertise
        ?? row.why_apply
        ?? row.motivation
        ?? row.reason
        ?? row.apply_reason
        ?? '';
    return String(v || 'Not specified');
}

function renderExpertApplicationRow(row) {
    const whyFull = expertWhyText(row);
    const credFull = String(row.credentials || 'Not provided');
    const name = escapeHtml(row.full_name || 'Applicant');
    const course = escapeHtml(row.course || 'No course');
    const st = escapeHtml(row.status || 'pending');
    const when = row.submitted_at ? formatDate(row.submitted_at) : '';
    const why = escapeHtml(whyFull.slice(0, 220));
    const cred = escapeHtml(credFull.slice(0, 220));
    const pending = String(row.status || 'pending').toLowerCase() === 'pending';
    const actions = `
        <div class="row-actions expert-app-actions">
            <button type="button" class="btn-expert-view" data-app-id="${row.id}">
                ${pending ? 'Review / accept or reject' : 'View full submission'}
            </button>
        </div>`;
    return `
        <article class="row" data-app-id="${row.id}">
            <p class="row-title">${name}</p>
            <p class="row-meta">${course} • ${st}${when ? ` • ${when}` : ''}</p>
            <p class="row-text"><strong>Why / motivation:</strong> ${why}${whyFull.length > 220 ? '…' : ''}</p>
            <p class="row-text"><strong>Credentials (preview):</strong> ${cred}${credFull.length > 220 ? '…' : ''}</p>
            ${actions}
        </article>`;
}

function isExpertApplicationDecidedApproved(row) {
    const s = String(row?.status || '').toLowerCase().trim();
    return s === 'approved' || s === 'accepted';
}

async function loadExpertApplications() {
    const container = document.getElementById('expertApplicationsList');
    try {
        const { data, error } = await supabase
            .from('expert_applications')
            .select('*')
            .order('submitted_at', { ascending: false })
            .limit(120);
        if (error) throw error;

        const visible = (data || []).filter((row) => !isExpertApplicationDecidedApproved(row));

        expertApplicationsById.clear();
        visible.forEach((row) => expertApplicationsById.set(row.id, row));

        if (!visible.length) {
            container.innerHTML =
                '<p class="empty">No applications in this queue right now. Pending and rejected submissions appear here; once approved, they move to <strong>Active wellness experts</strong>.</p>';
            return visible;
        }

        container.innerHTML = visible.map((row) => renderExpertApplicationRow(row)).join('');
        return visible;
    } catch (err) {
        container.innerHTML = `<p class="empty">Failed to load expert applications: ${escapeHtml(err?.message || 'Unknown error')}</p>`;
        return null;
    }
}

// ─── AI moderation summary panel ─────────────────────────────────────────────

async function loadAiModerationDashboardData() {
    try {
        const { count, error: cErr } = await supabase
            .from('ai_moderation_attempts')
            .select('*', { count: 'exact', head: true });
        if (cErr) throw cErr;

        const { data: rows, error: rErr } = await supabase
            .from('ai_moderation_attempts')
            .select('id, title_preview, reason, created_at, user_id')
            .order('created_at', { ascending: false })
            .limit(50);
        if (rErr) throw rErr;

        return { total: count || 0, rows: rows || [] };
    } catch (e) {
        console.warn('AI moderation attempts:', e?.message || e);
        return { total: null, rows: [] };
    }
}

function renderAiBlockAttemptsList(rows) {
    const container = document.getElementById('aiBlockAttemptsList');
    if (!container) return;
    if (!rows.length) {
        container.innerHTML = '<p class="empty">No AI block attempts logged yet. Run SQL/007_ai_moderation_attempts.sql and block a post with AI to see data here.</p>';
        return;
    }
    container.innerHTML = rows.map((r) => `
        <article class="row">
            <p class="row-title">${escapeHtml(r.title_preview || '(No title)')}</p>
            <p class="row-meta">${formatDate(r.created_at)}${r.user_id ? ` · User: ${escapeHtml(r.user_id)}` : ''}</p>
            <p class="row-text"><strong>AI reason:</strong> ${escapeHtml(r.reason || '—')}</p>
        </article>
    `).join('');
}

// ─── Admin Tool Cards & Modals ───────────────────────────────────────────────

const toolModalMap = {
    'total-users': 'directoryModal',
    'pending-posts': 'pendingPostsModal',
    'expert-apps': 'expertAppsModal',
    'active-experts': 'activeExpertsModal',
    'expert-history': 'expertHistoryModal',
    'reports': 'reportsModal',
    'reported-accounts': 'reportedAccountsModal',
    'ai-blocks': 'aiBlocksModal'
};
function initUserDirectory() {
  const card = document.querySelector('[data-tool="total-users"]');
  const badge = document.getElementById('directoryCount');
  const search = document.getElementById('directorySearch');
  const status = document.getElementById('directoryStatus');
  const list = document.getElementById('directoryList');

  let profiles = [];
  let loading = false;

  function renderList() {
    const term = search.value.trim().toLowerCase();
    const matches = profiles.filter(user =>
      [user.full_name, user.username].some(value =>
        (value || '').toLowerCase().includes(term)
      )
    );

    const items = document.createDocumentFragment();
      for (const user of matches) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      const name = user.full_name?.trim() || 'Unnamed user';
      const username = user.username?.trim();

      button.type = 'button';
      button.className = 'directory-user-button';
      button.setAttribute('aria-haspopup', 'dialog');
      const roleLabel = user.is_admin ? 'Admin' : (user.is_expert ? 'Verified Expert' : 'Student');
      button.textContent = username ? `${name} (@${username}) • ${roleLabel}` : `${name} • ${roleLabel}`;

            button.addEventListener('click', () => {
        const dialog = document.getElementById('directoryProfileDialog');
        const frame = document.getElementById('directoryProfileFrame');
        const url = new URL('/HTML/3_Profile.html', window.location.origin);

        url.searchParams.set('user', user.id);
        url.searchParams.set('view', 'directory');

        frame.title = `Profile of ${name}`;
        frame.src = url.href;
        dialog.showModal();
      });

      item.append(button);
      items.append(item);
    }

    list.replaceChildren(items);
    status.textContent = term
      ? `${matches.length} of ${profiles.length} users match your search.`
      : `${profiles.length} registered users.`;
  }

  async function loadList() {
    if (loading) return;
    loading = true;
    search.value = '';
    search.disabled = true;
    list.replaceChildren();
    status.textContent = 'Loading users…';

    try {
      let adminIds = new Set();
      try {
        const { data: admList } = await supabase.from('admins').select('user_id');
        if (admList) admList.forEach(a => { if (a.user_id) adminIds.add(a.user_id); });
      } catch (_) {}

      const users = [];
      let lastId = null;

      while (true) {
        let query = supabase.from('users')
          .select('id, full_name, username, is_expert, is_admin')
          .order('id', { ascending: true })
          .limit(500);

        if (lastId !== null) query = query.gt('id', lastId);

        const { data, error } = await query;
        if (error) throw error;
        if (!data.length) break;

        for (const u of data) {
          u.is_admin = !!u.is_admin || adminIds.has(u.id);
        }
        users.push(...data);
        lastId = data[data.length - 1].id;
      }

      profiles = users.sort((a, b) =>
        (a.full_name || a.username || '').localeCompare(b.full_name || b.username || '')
      );

      badge.textContent = String(profiles.length);
      renderList();
      search.disabled = false;
    } catch (error) {
      console.warn('User directory failed to load:', error);
      status.textContent = 'Could not load users. Reopen the tool to retry.';
    } finally {
      loading = false;
    }
  }

  search.disabled = true;
  search.addEventListener('input', renderList);
  card.addEventListener('click', loadList, { capture: true });

  supabase.from('users')
    .select('id', { count: 'exact', head: true })
    .then(({ count, error }) => {
      if (!error && count !== null && list.childElementCount === 0) {
        badge.textContent = String(count);
      }
    });
}
function initAdminToolCards() {
    try {
        // Card click handlers
        document.querySelectorAll('.admin-tool-card').forEach(card => {
            card.addEventListener('click', (e) => {
                // Don't open modal if clicking the button itself
                if (e.target.closest('.btn-open-tool')) {
                    e.stopPropagation();
                }
                
                const tool = card.dataset.tool;
                const modalId = toolModalMap[tool];
                if (modalId) {
                    const modal = document.getElementById(modalId);
                    if (modal) {
                        modal.classList.remove('hidden');
                    }
                }
            });
        });

        // Modal close handlers
        document.querySelectorAll('[data-close-modal]').forEach(btn => {
            btn.addEventListener('click', () => {
                const modalId = btn.dataset.closeModal;
                const modal = document.getElementById(modalId);
                if (modal) {
                    modal.classList.add('hidden');
                }
            });
        });

        // Close modal on backdrop click
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.classList.add('hidden');
                }
            });
        });

        // Expert search
        const expertSearchBtn = document.getElementById('expertSearchBtn');
        const expertSearchInput = document.getElementById('expertSearchInput');
        
        if (expertSearchBtn && expertSearchInput) {
            expertSearchBtn.addEventListener('click', () => {
                filterExperts(expertSearchInput.value);
            });
            
            expertSearchInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    filterExperts(expertSearchInput.value);
                }
            });
        }
    } catch (error) {
        console.warn('Admin tool cards initialization failed:', error);
    }
}

function filterExperts(searchTerm) {
    try {
        const term = searchTerm.toLowerCase();
        const expertsList = document.getElementById('approvedExpertsList');
        if (!expertsList) return;

        const expertRows = expertsList.querySelectorAll('.row');
        expertRows.forEach(row => {
            const text = row.textContent.toLowerCase();
            row.style.display = text.includes(term) ? '' : 'none';
        });
    } catch (error) {
        console.warn('Expert filter failed:', error);
    }
}

let dashboardReport;
let analyticsRunning = false;
let analyticsQueued = false;
let analyticsStarted = false;
const analyticsInterval = 30000;
const outcomeColors = {
    Approved: '#15b99b', Pending: '#e5a438', Rejected: '#df7078', Other: '#8396bb'
};

// Read only the columns needed by analytics. Keyset pagination also works
// when the server caps a response below the requested page size.
async function analyticsRows(table, columns, filter = query => query) {
    const rows = [];
    let lastId = null;
    while (true) {
        let query = filter(supabase.from(table).select(columns)).order('id').limit(500);
        if (lastId !== null) query = query.gt('id', lastId);
        const { data, error } = await query;
        if (error) throw error;
        if (!data.length) return rows;
        rows.push(...data);
        lastId = data[data.length - 1].id;
    }
}

async function analyticsCount(query) {
    const { count, error } = await query;
    if (error) throw error;
    return count;
}

async function recentEvents(table) {
    const rows = await analyticsRows(table, 'id,created_at');
    return { rows, count: rows.length };
}

function applicationOutcomes(rows) {
    if (!rows) return null;
    const counts = { Approved: 0, Pending: 0, Rejected: 0, Other: 0 };
    for (const row of rows) {
        const status = String(row.status || 'pending').trim().toLowerCase();
        if (isExpertApplicationDecidedApproved(row)) counts.Approved++;
        else if (status === 'pending') counts.Pending++;
        else if (status === 'rejected') counts.Rejected++;
        else counts.Other++;
    }
    return counts;
}

function renderOutcomes(counts, total) {
    const legend = document.getElementById('outcomeLegend');
    const ring = document.querySelector('.outcome-ring');
    legend.replaceChildren();
    ring.style.background = '';
    document.getElementById('outcomeTotal').textContent = total ?? '—';
    if (!total) {
        const message = document.createElement('li');
        message.textContent = total === 0 ? 'No applications yet.' : 'Application data unavailable.';
        legend.append(message);
        return;
    }
    const stops = [];
    let accumulated = 0;
    for (const [label, count] of Object.entries(counts)) {
        if (label === 'Other' && !count) continue;
        const start = accumulated / total * 100;
        accumulated += count;
        if (count) stops.push(outcomeColors[label] + ' ' + start + '% ' + accumulated / total * 100 + '%');
        const entry = document.createElement('li');
        const dot = document.createElement('i');
        dot.style.background = outcomeColors[label];
        entry.append(dot, label + ' · ' + count + ' of ' + total + ' (' +
            (count / total * 100).toLocaleString(undefined, { maximumFractionDigits: 1 }) + '%)');
        legend.append(entry);
    }
    ring.style.background = 'conic-gradient(' + stops.join(', ') + ')';
}

const activityPageSize = 8;
let activity = [];
let activityPage = 0;
let clearedThrough = 0;
let activityPartial = false;

let liveEvents = [];
let hiddenActivity = new Set();
let lastClear = [];
const localActions = new Map();

function activityStorageKey() {
    return 'gcfs:activity-view:' + currentUser.id;
}

function readActivityView() {
    try {
        const saved = JSON.parse(localStorage.getItem(activityStorageKey()) || '{}');
        hiddenActivity = new Set(saved.hidden || []);
        lastClear = saved.lastClear || [];
    } catch { /* Keep the current view if browser storage is unavailable. */ }
}

function saveActivityView() {
    try {
        localStorage.setItem(activityStorageKey(), JSON.stringify({hidden:[...hiddenActivity], lastClear}));
    } catch { /* Clear and Undo also work in memory for this visit. */ }
    activityPage = 0;
    mergeActivity();
}

function recordActivityAction(label) {
    const id = globalThis.crypto?.randomUUID?.() || Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
    const event = {id, label, actor_id:currentUser.id, created_at:new Date().toISOString()};
    localActions.set(event.id,event);
    try { localStorage.setItem('gcfs:action:'+currentUser.id+':'+event.id, JSON.stringify(event)); } catch {}
    refreshDashboardAnalytics();
}

function initActivityControls() {
    const storageKey = 'gcfs:cleared-activity:' + currentUser.id;
    try { clearedThrough = Number(localStorage.getItem(storageKey)) || 0; } catch {}
    for (const [id, offset] of [['previousActivity', -1], ['nextActivity', 1]]) {
        document.getElementById(id).addEventListener('click', () => {
            activityPage += offset;
            drawActivityPage();
            document.getElementById('activityEvents').scrollTop = 0;
        });
    }
    readActivityView();
    const actionPrefix='gcfs:action:'+currentUser.id+':';
    try {
        for (const key of Object.keys(localStorage).filter(key => key.startsWith(actionPrefix))) {
            const event=JSON.parse(localStorage.getItem(key));
            if (event) localActions.set(event.id,event);
        }
    } catch {}
    window.addEventListener('storage', event => {
        if (event.key === activityStorageKey()) { readActivityView(); mergeActivity(); }
        if (event.key?.startsWith(actionPrefix) && event.newValue) {
            const action=JSON.parse(event.newValue);
            localActions.set(action.id,action);
            refreshDashboardAnalytics();
        }
    });
    document.getElementById('clearActivity').onclick = () => {
        const keys = activity.map(event => event.key).filter(key => !hiddenActivity.has(key));
        if (!keys.length) return;
        lastClear = keys;
        for (const key of keys) hiddenActivity.add(key);
        saveActivityView();
    };
    document.getElementById('undoActivity').onclick = () => {
        for (const key of lastClear) hiddenActivity.delete(key);
        lastClear = [];
        saveActivityView();
    };
}

function renderActivity(flags, accounts, blocks, actions, people) {
    const actor=id=>people.get(id)?.full_name || (people.get(id)?.username && '@'+people.get(id).username);
    liveEvents=[];
    const sources=[
        ['Post reported',flags?.filter(r=>!String(r.flagged_by||'').toLowerCase().includes('ai')),r=>actor(r.flagged_by)||'Reporter unavailable'],
        ['Account reported',accounts?.rows,r=>actor(r.reporter_id)||'Reporter unavailable'],
        ['AI block attempt',blocks?.rows,()=>'AI moderation'],
        ['Admin action',actions,r=>actor(r.actor_id)||'Admin unavailable']
    ];
    activityPartial=sources.some(([,rows])=>!rows);
    for(const [kind,rows,who] of sources) for(const r of rows||[]) {
        const time=Date.parse(r.created_at);
        if(time>clearedThrough)liveEvents.push({key:kind+':'+r.id,time,label:(r.label||kind)+' · '+who(r)});
    }
    mergeActivity();
}

function mergeActivity(){
    const anchor = activityPage > 0 && activity[activityPage * activityPageSize]?.key;
    activity = liveEvents.filter(event => !hiddenActivity.has(event.key))
        .sort((a,b)=>b.time-a.time || a.key.localeCompare(b.key));
    if (anchor) {
        const index = activity.findIndex(event => event.key === anchor);
        if (index >= 0) activityPage = Math.floor(index / activityPageSize);
    }
    drawActivityPage();
}

function drawActivityPage() {
    const pages = Math.max(1, Math.ceil(activity.length / activityPageSize));
    activityPage = Math.max(0, Math.min(activityPage, pages - 1));
    const start = activityPage * activityPageSize;
    const list = document.getElementById('activityEvents');
    const scroll = list.scrollTop;
    list.replaceChildren();
    for (const event of activity.slice(start, start + activityPageSize)) {
        const item = document.createElement('li');
        const stamp = document.createElement('time');
        const date = new Date(event.time);
        stamp.dateTime = date.toISOString();
        stamp.textContent = date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
        item.append(event.label, stamp);
        list.append(item);
    }
    list.scrollTop = scroll;
    document.getElementById('activityPage').textContent = 'Page ' + (activityPage + 1) + ' of ' + pages;
    document.getElementById('previousActivity').disabled = activityPage === 0;
    document.getElementById('nextActivity').disabled = activityPage + 1 === pages;
    document.getElementById('clearActivity').disabled = !activity.length;
    document.getElementById('undoActivity').hidden = !lastClear.length;
    const status = activity.length ? activity.length + ' recorded events' : 'No activity to display.';
    document.getElementById('activityStatus').textContent = activityPartial ? status + ' Some sources unavailable.' : status;
}

async function refreshDashboardAnalytics() {
    if (document.hidden) return;
    if (analyticsRunning) {
        analyticsQueued = true;
        return;
    }
    analyticsRunning = true;
    try {
        const results = await Promise.allSettled([
            analyticsRows('expert_applications', 'id,user_id,status'),
            analyticsRows('flagged_content', 'id,post_id,flagged_by,status,created_at'),
            analyticsRows('reported_accounts','id,reported_user_id,reporter_id,created_at').then(rows=>({rows,count:rows.length})),
            recentEvents('ai_moderation_attempts'),
            analyticsCount(supabase.from('posts').select('id', { head: true, count: 'exact' }).eq('status', 'pending')),
            analyticsCount(supabase.from('users').select('id', { head: true, count: 'exact' }).eq('is_expert', true)),
            analyticsProfiles()
        ]);
        const [apps, flags, accounts, blocks, pending, active, people] = results.map(result =>
            result.status === 'fulfilled' ? result.value : null);
        const outcomes = applicationOutcomes(apps);
        const approvedUsers = apps && new Set(apps.filter(isExpertApplicationDecidedApproved)
            .map(row => row.user_id || 'application:' + row.id)).size;
        const metrics = [];
        const boxes = document.getElementById('moderationCounts');
        boxes.replaceChildren();
        function add(group, label, count, badge) {
            metrics.push({ group, label, count });
            if (badge) document.getElementById(badge).textContent = count ?? (badge === 'reportedAccountsBadge' ? '0' : '—');
            if (group !== 'Moderation') return;
            const box = document.createElement('div');
            const value = document.createElement('strong');
            const caption = document.createElement('span');
            value.textContent = count ?? 'Unavailable';
            caption.textContent = label;
            box.append(value, caption);
            boxes.append(box);
        }
        add('Moderation', 'Pending post approvals', pending, 'pendingPostsBadge');
        add('Moderation', 'User-reported posts', flags?.filter(isUserReportModerationQueueRow).length, 'reportsBadge');
        add('Moderation', 'Reported accounts', accounts?.count, 'reportedAccountsBadge');
        add('Moderation', 'AI block attempts', blocks?.count, 'aiBlocksBadge');
        add('Wellness experts', 'Pending applications', outcomes?.Pending, 'expertAppsBadge');
        add('Wellness experts', 'Active wellness experts', active, 'activeExpertsBadge');
        add('Wellness experts', 'Approved experts history', approvedUsers, 'expertHistoryBadge');
        for (const label of Object.keys(outcomeColors)) add('Expert applications', label, outcomes?.[label]);
        renderOutcomes(outcomes, apps?.length);
        const userMap=await prepareStudentReports(flags,accounts?.rows || null,people);
        renderActivity(flags,accounts,blocks,[...localActions.values()],userMap);
        const updated = new Date().toISOString();
        dashboardReport = { updated, metrics };
        const partial = results.some(result => result.status === 'rejected');
        document.getElementById('reportStamp').textContent =
            (partial ? 'Partial data · Last checked ' : 'Updated ') + new Date(updated).toLocaleTimeString() +
            ' · Refreshes every 30 seconds';
        document.querySelectorAll('[data-report-format]').forEach(button => { button.disabled = false; });
    } finally {
        analyticsRunning = false;
        if (analyticsQueued) {
            analyticsQueued = false;
            refreshDashboardAnalytics();
        }
    }
}

function updateDashboardAnalytics() {
    if (!analyticsStarted) {
        analyticsStarted = true;
        window.setInterval(refreshDashboardAnalytics, analyticsInterval);
        document.addEventListener('visibilitychange', refreshDashboardAnalytics);
        // Receive changes immediately for tables included in the project's
        // Realtime publication. Polling covers disconnected/unpublished tables.
        if (typeof supabase.channel === 'function') {
            const channel = supabase.channel('admin-dashboard-analytics');
            let timer;
            const onChange = () => {
                if (timer) return;
                timer = setTimeout(() => { timer = null; refreshDashboardAnalytics(); }, 500);
            };
            for (const table of ['expert_applications', 'users', 'posts', 'reported_accounts', 'flagged_content', 'ai_moderation_attempts']) {
                channel.on('postgres_changes', { event: '*', schema: 'public', table }, onChange);
            }
            channel.subscribe();
        }
    }
    refreshDashboardAnalytics();
}

// ─── Orchestrate full dashboard refresh ──────────────────────────────────────

async function loadAdminDashboard() {
    flaggedRowsById.clear();

    await purgeExpiredUserReports();
    await purgeExpiredReportedAccounts();

    const [, expertsResult, historyResult, flaggedResult, aiData, reportedAccountsResult, pendingPostsResult] =
        await Promise.all([
            loadExpertApplications(),
            loadApprovedExperts(),
            loadApprovedExpertHistory(),
            loadFlaggedContent(),
            loadAiModerationDashboardData(),
            loadReportedAccounts(),
            loadPendingPosts()
        ]);

    const flaggedRows = flaggedResult?.rows || [];
    const userReported = flaggedRows.filter(isUserReportModerationQueueRow);
    const pendingPosts = pendingPostsResult?.rows || [];

    updateDashboardAnalytics();

    renderAiBlockAttemptsList(aiData.rows);
    renderApprovedExpertsList(expertsResult);
    renderApprovedExpertHistory(historyResult);
    renderPendingPostsList(pendingPosts);

    if (flaggedResult?.errorMessage) {
        const msg = escapeHtml(flaggedResult.errorMessage);
        document.getElementById('reportedPostsList').innerHTML = `<p class="empty">Failed to load reported posts: ${msg}</p>`;
        renderReportedAccountsSection(reportedAccountsResult);
        return;
    }

    await renderFlaggedSection(userReported, 'reportedPostsList');
    renderReportedAccountsSection(reportedAccountsResult);
}

async function loadApprovedExpertHistory() {
    try {
        const { data, error } = await supabase
            .from('expert_applications')
            .select('id, user_id, full_name, course, submitted_at, status')
            .order('submitted_at', { ascending: false })
            .limit(150);

        if (error) throw error;

        const approved = (data || []).filter((a) => {
            const s = String(a.status || '').toLowerCase().trim();
            return s === 'approved' || s === 'accepted';
        });

        /** One card per person: same user can have multiple approved rows if they re-applied. */
        const byUser = new Map();
        const withoutUserId = [];
        for (const app of approved) {
            const uid = app.user_id;
            if (!uid) {
                withoutUserId.push({ ...app, applicationCount: 1 });
                continue;
            }
            if (!byUser.has(uid)) byUser.set(uid, []);
            byUser.get(uid).push(app);
        }
        const merged = [...withoutUserId];
        for (const apps of byUser.values()) {
            apps.sort(
                (a, b) =>
                    new Date(b.submitted_at || 0).getTime() - new Date(a.submitted_at || 0).getTime()
            );
            const latest = apps[0];
            merged.push({
                ...latest,
                applicationCount: apps.length
            });
        }
        merged.sort(
            (a, b) =>
                new Date(b.submitted_at || 0).getTime() - new Date(a.submitted_at || 0).getTime()
        );

        const userIds = [...new Set(merged.map((a) => a.user_id).filter(Boolean))];
        const userMap = {};
        if (userIds.length) {
            const { data: usersRows } = await supabase
                .from('users')
                .select('id, is_expert, full_name, username, email, course')
                .in('id', userIds);
            (usersRows || []).forEach((u) => {
                userMap[u.id] = u;
            });
        }

        const rows = merged.map((app) => ({
            ...app,
            stillActive: !!(userMap[app.user_id]?.is_expert),
            userRow: userMap[app.user_id] || null
        }));

        return {
            rows,
            count: rows.length,
            totalApplicationRecords: approved.length,
            errorMessage: ''
        };
    } catch (err) {
        return { rows: [], count: 0, errorMessage: err?.message || String(err) };
    }
}

function renderApprovedExpertHistory(result) {
    const container = document.getElementById('approvedExpertHistoryList');
    if (!container) return;

    const msg = result?.errorMessage;
    if (msg) {
        container.innerHTML = `<p class="empty">Could not load history: ${escapeHtml(msg)}</p>`;
        return;
    }

    const rows = result?.rows || [];
    if (!rows.length) {
        container.innerHTML = '<p class="empty">No approved applications yet. When you accept applicants, they appear here permanently for your records.</p>';
        return;
    }

    container.innerHTML = rows.map((app) => {
        const displayName = escapeHtml(app.full_name || app.userRow?.full_name || app.userRow?.username || 'User');
        const course = escapeHtml(app.course || app.userRow?.course || '—');
        const email = app.userRow?.email ? escapeHtml(app.userRow.email) : '';
        const when = app.submitted_at ? formatDate(app.submitted_at) : '';
        const dupNote =
            app.applicationCount > 1 ? ` · ${app.applicationCount} applications on file` : '';
        const badge = app.stillActive
            ? '<span class="expert-history-badge expert-history-badge--active">Active expert</span>'
            : '<span class="expert-history-badge expert-history-badge--revoked">Revoked</span>';
        const removeBtn = app.stillActive && app.user_id
            ? `<div class="row-actions expert-app-actions"><button type="button" class="btn-revoke-expert" data-user-id="${app.user_id}">Remove expert status…</button></div>`
            : '';
        return `
            <article class="row approved-history-row">
                <p class="row-title">${displayName} ${badge}</p>
                <p class="row-meta">${course}${email ? ` · ${email}` : ''}${when ? ` · Latest application ${when}` : ''}${dupNote}</p>
                ${removeBtn}
            </article>`;
    }).join('');
}

/** Latest approved/accepted application per user_id (for credentials on active experts). */
function mergeLatestApprovedApplications(users, appRows) {
    const latestByUser = {};
    (appRows || []).forEach((a) => {
        const st = String(a.status || '').toLowerCase().trim();
        if (st !== 'approved' && st !== 'accepted') return;
        const uid = a.user_id;
        if (!uid) return;
        const prev = latestByUser[uid];
        const t = new Date(a.submitted_at || 0).getTime();
        if (!prev || t > new Date(prev.submitted_at || 0).getTime()) latestByUser[uid] = a;
    });
    return (users || []).map((u) => ({
        ...u,
        expertApplication: latestByUser[u.id] || null
    }));
}

async function loadApprovedExperts() {
    try {
        const { data, error } = await supabase
            .from('users')
            .select('id, full_name, username, email, course, expert_title, is_expert')
            .eq('is_expert', true)
            .order('full_name', { ascending: true });

        if (error) throw error;

        const userRows = data || [];
        const userIds = userRows.map((u) => u.id).filter(Boolean);
        let appRows = [];
        if (userIds.length) {
            const { data: apps, error: appErr } = await supabase
                .from('expert_applications')
                .select('*')
                .in('user_id', userIds)
                .order('submitted_at', { ascending: false });
            if (!appErr) appRows = apps || [];
        }

        const merged = mergeLatestApprovedApplications(userRows, appRows);

        approvedExpertsById.clear();
        merged.forEach((u) => approvedExpertsById.set(u.id, u));

        return { rows: merged, count: merged.length, errorMessage: '' };
    } catch (err) {
        return { rows: [], count: 0, errorMessage: err?.message || String(err) };
    }
}

function renderApprovedExpertsList(result) {
    const container = document.getElementById('approvedExpertsList');
    if (!container) return;

    const msg = result?.errorMessage;
    if (msg) {
        container.innerHTML = `<p class="empty">Could not load experts: ${escapeHtml(msg)}</p>`;
        return;
    }

    const rows = result?.rows || [];
    if (!rows.length) {
        container.innerHTML =
            '<p class="empty">No active wellness experts right now. Approve a pending application in <strong>Expert applications</strong> to add someone here. Click an expert in this list to open their full application on file.</p>';
        return;
    }

    container.innerHTML = rows.map((u) => {
        const displayName = escapeHtml(u.full_name || u.username || 'User');
        const handle = u.username ? `@${escapeHtml(u.username)}` : '';
        const email = escapeHtml(u.email || '—');
        const course = escapeHtml(u.course || '—');
        const title = u.expert_title ? escapeHtml(String(u.expert_title)) : '';
        const hasAppRec = !!u.expertApplication;
        const appHint = hasAppRec
            ? 'Click to view motivation & credentials from their application.'
            : 'Click for details (no application file on record).';
        return `
            <article class="row approved-expert-row approved-expert-row--compact" data-user-id="${u.id}">
                <button type="button" class="approved-expert-expand">
                    <p class="row-title">${displayName}${handle ? ` <span class="row-sub">${handle}</span>` : ''}</p>
                    <p class="row-meta">${email}${course !== '—' ? ` · ${course}` : ''}</p>
                    ${title ? `<p class="row-text"><strong>Expert title:</strong> ${title}</p>` : ''}
                    <p class="approved-expert-tap-hint">${appHint}</p>
                </button>
                <div class="row-actions expert-app-actions">
                    <button type="button" class="btn-revoke-expert" data-user-id="${u.id}">Remove expert status…</button>
                </div>
            </article>`;
    }).join('');
}

// ─── Active experts: detail & revoke expert status ───────────────────────────

function closeActiveExpertDetailModal() {
    document.getElementById('activeExpertDetailModal')?.classList.add('hidden');
}

function openActiveExpertDetailModal(userId) {
    const u = approvedExpertsById.get(userId);
    if (!u) {
        showAppAlert('Experts', 'Could not load this expert. Refresh the dashboard.', 'info');
        return;
    }

    const displayName = u.full_name || u.username || 'User';
    const heading = document.getElementById('activeExpertDetailHeading');
    if (heading) heading.textContent = displayName;

    const handle = u.username ? `@${u.username}` : '';
    const meta = document.getElementById('activeExpertDetailMeta');
    if (meta) {
        meta.textContent = `${displayName}${handle ? ` ${handle}` : ''} · ${u.email || '—'} · ${u.course || '—'}`;
    }

    const titleLine = document.getElementById('activeExpertDetailTitleLine');
    if (titleLine) {
        if (u.expert_title) {
            titleLine.textContent = `Expert title: ${u.expert_title}`;
            titleLine.classList.remove('hidden');
        } else {
            titleLine.textContent = '';
            titleLine.classList.add('hidden');
        }
    }

    const hasAppEl = document.getElementById('activeExpertDetailHasApp');
    const noAppEl = document.getElementById('activeExpertDetailNoApp');
    const whyEl = document.getElementById('activeExpertDetailWhy');
    const credEl = document.getElementById('activeExpertDetailCredentials');
    const app = u.expertApplication;

    if (app && whyEl && credEl) {
        hasAppEl?.classList.remove('hidden');
        noAppEl?.classList.add('hidden');
        whyEl.textContent = expertWhyText(app) || '—';
        credEl.textContent = String(app.credentials || 'Not provided');
    } else {
        hasAppEl?.classList.add('hidden');
        noAppEl?.classList.remove('hidden');
        if (whyEl) whyEl.textContent = '';
        if (credEl) credEl.textContent = '';
    }

    document.getElementById('activeExpertDetailModal')?.classList.remove('hidden');
}

function setupActiveExpertDetailModal() {
    document.getElementById('closeActiveExpertDetailModal')?.addEventListener('click', closeActiveExpertDetailModal);
    document.getElementById('activeExpertDetailModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'activeExpertDetailModal') closeActiveExpertDetailModal();
    });
    document.getElementById('approvedExpertsList')?.addEventListener('click', (e) => {
        if (e.target.closest('.btn-revoke-expert')) return;
        if (!e.target.closest('.approved-expert-expand')) return;
        const uid = e.target.closest('[data-user-id]')?.getAttribute('data-user-id');
        if (uid) openActiveExpertDetailModal(uid);
    });
}

async function openRevokeExpertModal(userId) {
    if (!userId || !supabase) return;

    let u = approvedExpertsById.get(userId);
    if (!u) {
        const { data, error } = await supabase
            .from('users')
            .select('id, full_name, username, email, course')
            .eq('id', userId)
            .maybeSingle();
        if (error || !data) {
            showAppAlert('Experts', 'Could not load this user. They may have been removed.', 'error');
            return;
        }
        u = data;
    }

    revokeExpertPendingUserId = userId;
    const intro = document.getElementById('revokeExpertIntro');
    const ta = document.getElementById('revokeExpertReason');
    if (intro) {
        intro.innerHTML = `You are removing wellness expert status from <strong>${escapeHtml(u.full_name || u.username || 'this user')}</strong>.`;
    }
    if (ta) ta.value = '';
    document.getElementById('revokeExpertModal')?.classList.remove('hidden');
}

function closeRevokeExpertModal() {
    revokeExpertPendingUserId = null;
    document.getElementById('revokeExpertModal')?.classList.add('hidden');
}

function setupRevokeExpertModalEvents() {
    document.getElementById('closeRevokeExpertModal')?.addEventListener('click', closeRevokeExpertModal);
    document.getElementById('cancelRevokeExpertBtn')?.addEventListener('click', closeRevokeExpertModal);
    document.getElementById('revokeExpertModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'revokeExpertModal') closeRevokeExpertModal();
    });

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-revoke-expert');
        if (!btn) return;
        const uid = btn.getAttribute('data-user-id');
        if (uid) void openRevokeExpertModal(uid);
    });

    document.getElementById('confirmRevokeExpertBtn')?.addEventListener('click', async () => {
        const uid = revokeExpertPendingUserId;
        if (!uid || !supabase) return;

        const reasonRaw = document.getElementById('revokeExpertReason')?.value?.trim() || '';
        if (reasonRaw.length < 10) {
            showAppAlert('Reason required', 'Please enter a clear reason (at least 10 characters). This will be sent to the user.', 'error');
            return;
        }

        let proceed = true;
        if (typeof CustomAlert !== 'undefined' && typeof CustomAlert.confirm === 'function') {
            proceed = await CustomAlert.confirm(
                'Remove expert status',
                'They will lose expert privileges immediately and receive your reason by notification.',
                { confirmText: 'Remove', cancelText: 'Cancel', danger: true }
            );
        } else if (typeof confirm === 'function') {
            proceed = confirm('Remove this user\'s wellness expert status?');
        }
        if (!proceed) return;

        try {
            // Preferred path: SECURITY DEFINER RPC (needs SQL/013_admin_expert_rpc.sql).
            // It verifies admin server-side and bypasses users-table RLS entirely.
            let { error: rpcErr } = await supabase.rpc('gcfs_admin_revoke_expert', { p_user_id: uid });
            const rpcMissing = rpcErr && /function|routine|does not exist|schema cache/i.test(String(rpcErr.message || ''));

            if (rpcErr && !rpcMissing) {
                showAppAlert(
                    'Could not remove expert status',
                    rpcErr.message || 'The admin RPC rejected the request.',
                    'error'
                );
                return;
            }

            if (rpcMissing) {
                // Fallback: direct table update (needs SQL/011 policies)
                let { error: upErr } = await supabase
                    .from('users')
                    .update({ is_expert: false, expert_title: '' })
                    .eq('id', uid)
                    .eq('is_expert', true);

                if (upErr && /expert_title|column/i.test(String(upErr.message || ''))) {
                    ({ error: upErr } = await supabase
                        .from('users')
                        .update({ is_expert: false })
                        .eq('id', uid)
                        .eq('is_expert', true));
                }

                if (upErr) {
                    showAppAlert(
                        'Expert status blocked (database)',
                        'Could not update users.is_expert — Row Level Security is blocking the update.\n\n'
                            + 'Run SQL/013_admin_expert_rpc.sql in the Supabase SQL Editor (it contains the admin RPC), then try again.\n\n'
                            + `Details: ${upErr.message || upErr}`,
                        'error'
                    );
                    return;
                }
            }

            const notifBody =
                `Your wellness expert status has been removed.\n\nReason:\n${reasonRaw}\n\nIf you have questions, contact the GC FitShare team through Info & Support.`;

            const { error: nErr } = await supabase.from('notifications').insert({
                user_id: uid,
                actor_id: currentUser.id,
                type: 'expert_status_revoked',
                title: 'Wellness expert status removed',
                message: notifBody,
                is_read: false
            });
            if (nErr) console.warn('Revoke notification:', nErr.message || nErr);

            closeRevokeExpertModal();
            recordActivityAction('Expert status removed');
            showAppAlert('Updated', 'Expert status removed and the user has been notified.', 'success');
            await loadAdminDashboard();
        } catch (err) {
            showAppAlert('Could not remove expert status', err?.message || String(err), 'error');
        }
    });
}

// ─── Flagged content list, retention purge, render ───────────────────────────

/** Deletes user reports (non-AI flags) older than USER_REPORT_RETENTION_MS. Returns rows removed or -1 if skipped. */
async function purgeExpiredUserReports() {
    if (!supabase) return 0;
    try {
        const { data: rpcN, error: rpcErr } = await supabase.rpc('purge_user_reports_older_than', { days: 30 });
        if (!rpcErr && typeof rpcN === 'number') return rpcN;
    } catch (_) {
        /* RPC may not be installed yet — fall back below */
    }

    const cutoffIso = new Date(Date.now() - USER_REPORT_RETENTION_MS).toISOString();
    try {
        const { data: rows, error: selErr } = await supabase
            .from('flagged_content')
            .select('id, flagged_by')
            .lt('created_at', cutoffIso);
        if (selErr) {
            console.warn('Purge user reports (select):', selErr.message || selErr);
            return 0;
        }
        const ids = (rows || [])
            .filter((r) => !String(r.flagged_by || '').toLowerCase().includes('ai'))
            .map((r) => r.id);
        let removed = 0;
        const chunk = 80;
        for (let i = 0; i < ids.length; i += chunk) {
            const slice = ids.slice(i, i + chunk);
            const { error: delErr } = await supabase.from('flagged_content').delete().in('id', slice);
            if (delErr) {
                console.warn('Purge user reports (delete):', delErr.message || delErr);
                break;
            }
            removed += slice.length;
        }
        return removed;
    } catch (e) {
        console.warn('Purge user reports:', e?.message || e);
        return 0;
    }
}

async function purgeExpiredReportedAccounts() {
    const cutoffIso = new Date(Date.now() - USER_REPORT_RETENTION_MS).toISOString();
    try {
        const { data: rows, error: selErr } = await supabase
            .from('reported_accounts')
            .select('id')
            .lt('created_at', cutoffIso);
        if (selErr) {
            if (/relation|does not exist|schema cache/i.test(String(selErr.message || ''))) return 0;
            console.warn('Purge reported_accounts (select):', selErr.message || selErr);
            return 0;
        }
        const ids = (rows || []).map((r) => r.id);
        let removed = 0;
        const chunk = 80;
        for (let i = 0; i < ids.length; i += chunk) {
            const slice = ids.slice(i, i + chunk);
            const { error: delErr } = await supabase.from('reported_accounts').delete().in('id', slice);
            if (delErr) {
                console.warn('Purge reported_accounts (delete):', delErr.message || delErr);
                break;
            }
            removed += slice.length;
        }
        return removed;
    } catch (e) {
        console.warn('Purge reported_accounts:', e?.message || e);
        return 0;
    }
}

async function loadReportedAccounts() {
    try {
        const rows = await analyticsRows('reported_accounts', `
                id, 
                reported_user_id, 
                reporter_id, 
                reason, 
                details, 
                status, 
                created_at,
                reported_user:users!reported_accounts_reported_user_id_fkey(full_name, username),
                reporter:users!reported_accounts_reporter_id_fkey(full_name, username)
            `);
        rows.sort((a,b)=>b.created_at.localeCompare(a.created_at) || String(a.id).localeCompare(String(b.id)));
        return { rows, errorMessage:'' };
    } catch (err) {
        return { rows: [], errorMessage: err?.message || String(err) };
    }
}

async function loadPendingPosts() {
    try {
        const { data, error } = await supabase
            .from('posts')
            .select('*')
            .eq('status', 'pending')
            .order('created_at', { ascending: false })
            .limit(100);

        if (error) throw error;

        const userIds = [...new Set((data || []).map(p => p.user_id).filter(Boolean))];
        const userMap = {};
        if (userIds.length) {
            const { data: users } = await supabase
                .from('users')
                .select('id, full_name, username, email, course')
                .in('id', userIds);
            (users || []).forEach(u => {
                userMap[u.id] = u;
            });
        }

        const rows = (data || []).map(post => ({
            ...post,
            user: userMap[post.user_id] || null
        }));

        return { rows, errorMessage: '' };
    } catch (err) {
        console.warn('loadPendingPosts:', err?.message || err);
        return { rows: [], errorMessage: err?.message || String(err) };
    }
}

function renderPendingPostsList(posts) {
    const container = document.getElementById('pendingPostsList');
    if (!container) return;

    if (!posts || posts.length === 0) {
        container.innerHTML = '<p class="empty">No posts pending approval.</p>';
        return;
    }

    container.innerHTML = posts.map(post => {
        const user = post.user || {};
        const authorName = user.full_name || user.username || 'Unknown User';
        const authorEmail = user.email || '';
        const authorCourse = user.course || '';
        const category = post.category || 'general';
        const imageHtml = post.image_url ? `<img src="${post.image_url}" alt="Post image" class="post-image-preview">` : '';
        const excerpt = post.body ? post.body.substring(0, 150) + (post.body.length > 150 ? '...' : '') : '';

        return `
            <article class="pending-post-card" data-post-id="${post.id}">
                <div class="post-header">
                    <div class="post-author">
                        <strong>${escapeHtml(authorName)}</strong>
                        <span class="post-author-email">${escapeHtml(authorEmail)}</span>
                        ${authorCourse ? `<span class="post-author-course">• ${escapeHtml(authorCourse)}</span>` : ''}
                    </div>
                    <div class="post-meta">
                        <span class="post-date">${formatDate(post.created_at)}</span>
                        <span class="post-category-badge">${escapeHtml(category)}</span>
                    </div>
                </div>
                ${post.title ? `<h3 class="post-title">${escapeHtml(post.title)}</h3>` : ''}
                ${imageHtml}
                ${excerpt ? `<p class="post-excerpt">${escapeHtml(excerpt)}</p>` : ''}
                ${post.hashtags ? `<div class="post-hashtags">${escapeHtml(post.hashtags)}</div>` : ''}
                <div class="post-actions">
                    <button type="button" class="btn-approve" data-post-id="${post.id}">Approve</button>
                    <button type="button" class="btn-reject" data-post-id="${post.id}">Reject</button>
                </div>
            </article>
        `;
    }).join('');

    // Add event listeners for approve/reject buttons
    container.querySelectorAll('.btn-approve').forEach(btn => {
        btn.addEventListener('click', () => approvePost(btn.dataset.postId));
    });
    container.querySelectorAll('.btn-reject').forEach(btn => {
        btn.addEventListener('click', () => rejectPost(btn.dataset.postId));
    });
}

async function approvePost(postId) {
    try {
        const { error } = await supabase
            .from('posts')
            .update({ status: 'published', updated_at: new Date().toISOString() })
            .eq('id', postId);

        if (error) throw error;

        recordActivityAction('Post approved');
        showAppAlert('Post Approved', 'The post has been approved and is now visible to users.', 'success');
        await loadAdminDashboard();
    } catch (err) {
        console.error('Error approving post:', err);
        showAppAlert('Error', 'Failed to approve post. Please try again.', 'error');
    }
}

async function rejectPost(postId) {
    const reason = prompt('Please provide a reason for rejection (optional):');
    if (reason === null) return; // admin cancelled the prompt

    try {
        // Grab the author first so we can notify them
        const { data: post } = await supabase
            .from('posts')
            .select('user_id, title')
            .eq('id', postId)
            .maybeSingle();

        const { error } = await supabase
            .from('posts')
            .update({
                status: 'rejected',
                updated_at: new Date().toISOString()
            })
            .eq('id', postId);

        if (error) throw error;

        if (post?.user_id) {
            const titlePreview = post.title ? ` "${String(post.title).substring(0, 60)}"` : '';
            await supabase.from('notifications').insert({
                user_id: post.user_id,
                actor_id: currentUser?.id || null,
                type: 'post_rejected',
                title: 'Your post was not approved',
                message: `Your post${titlePreview} was reviewed and not approved.${reason ? ` Reason: ${reason}` : ' You may edit and resubmit it.'}`,
                is_read: false,
                post_id: postId
            }).then(() => {}, () => {});
        }

        recordActivityAction('Post rejected');
        showAppAlert('Post Rejected', 'The post has been rejected and the student has been notified.', 'success');
        await loadAdminDashboard();
    } catch (err) {
        console.error('Error rejecting post:', err);
        showAppAlert('Error', 'Failed to reject post. Please try again.', 'error');
    }
}

let reportedAccountsPage = 0;

function renderReportedAccountsSection(result) {
    const list = document.getElementById('reportedAccountsList');
    const rows = result?.rows || [];
    const page = pageOfFive('accounts',rows,reportedAccountsPage,index=>{
        reportedAccountsPage=index;
        renderReportedAccountsSection(result);
        list.scrollTop=0;
    });
    reportedAccountsPage=page.index;
    list.replaceChildren();
    if (!rows.length) {
        list.textContent=result?.errorMessage ? 'Could not load account reports. '+result.errorMessage : 'No reported accounts yet.';
        return;
    }
    list.innerHTML = page.rows
        .map(
            (r) => `
            <article class="row">
                <p class="row-title">Reported User: <strong>${escapeHtml(r.reported_user?.full_name || r.reported_user?.username || r.reported_user_id)}</strong></p>
                <p class="row-meta">
                    ${escapeHtml(formatDate(r.created_at))} 
                    · <strong>Reported By:</strong> ${escapeHtml(r.reporter?.full_name || r.reporter?.username || r.reporter_id)} 
                    · ${formatFlagStatusBadge(r.status)}
                </p>
                <p class="row-text"><strong>Reason:</strong> ${escapeHtml(r.reason || '—')}</p>
                ${r.details ? `<p class="row-text"><strong>Details:</strong> ${escapeHtml(r.details)}</p>` : ''}
            </article>`
        )
        .join('');
}

async function loadFlaggedContent() {
    try {
        const { data, error } = await supabase
            .from('flagged_content')
            .select('id, post_id, flagged_by, reason, status, created_at')
            .order('created_at', { ascending: false })
            .limit(100);
        if (error) throw error;
        return { rows: data || [], errorMessage: '' };
    } catch (err) {
        return { rows: [], errorMessage: err?.message || 'Unknown error' };
    }
}

function formatFlagStatusBadge(statusRaw) {
    const raw = String(statusRaw || 'pending').toLowerCase().trim().replace(/\s+/g, '_');
    const labels = {
        pending: 'Pending',
        in_review: 'In review',
        resolved: 'Resolved',
        dismissed: 'Dismissed'
    };
    const cssKeys = new Set(['pending', 'in_review', 'resolved', 'dismissed']);
    const cssKey = cssKeys.has(raw) ? raw : 'other';
    const label = labels[raw] || String(statusRaw || 'pending').replace(/_/g, ' ') || 'Pending';
    return `<strong class="flag-status flag-status--${cssKey}">${escapeHtml(label)}</strong>`;
}

async function renderFlaggedSection(rows, targetId) {
    const container = document.getElementById(targetId);
    if (!rows.length) {
        container.innerHTML = '<p class="empty">No items found.</p>';
        return;
    }

    rows.forEach((r) => flaggedRowsById.set(r.id, r));

    const postIds = [...new Set(rows.map((r) => r.post_id).filter(Boolean))];
    let postMap = {};
    if (postIds.length) {
        const { data: posts } = await supabase
            .from('posts')
            .select('id, title, body')
            .in('id', postIds);
        (posts || []).forEach((p) => { postMap[p.id] = p; });
    }

    container.innerHTML = rows.map((row) => {
        const post = postMap[row.post_id] || {};
        return `
            <article class="row">
                <p class="row-title">${escapeHtml(post.title || 'Untitled Post')}</p>
                <p class="row-meta flag-status-row"><span class="flag-status-prefix">Status:</span> ${formatFlagStatusBadge(row.status)} <span class="flag-meta-sep">•</span> <span class="flag-flagged-at">Flagged: ${escapeHtml(formatDate(row.created_at))}</span></p>
                <p class="row-text"><strong>Reason:</strong> ${escapeHtml(row.reason || 'No reason provided')}</p>
                <p class="row-text"><strong>Snippet:</strong> ${escapeHtml((post.body || '').slice(0, 180) || 'No body text')}</p>
                <div class="row-actions">
                    <button type="button" class="btn-review-flag" data-flag-id="${row.id}">Review full post &amp; moderate</button>
                </div>
            </article>`;
    }).join('');
}
