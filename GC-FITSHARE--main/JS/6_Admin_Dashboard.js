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

    document.querySelector('.dashboard-container')?.addEventListener('click', (e) => {
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

        hideAdminAccessGate();
        applyAdminMobileSidebarDefaults();
        window.addEventListener('resize', syncAdminSidebarDesktopBreakpoint);

        document.getElementById('sidebarToggle')?.addEventListener('click', () => {
            document.getElementById('sidebar')?.classList.toggle('hidden');
        });

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
        return [];
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
        return { total: 0, rows: [] };
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
    'pending-posts': 'pendingPostsModal',
    'expert-apps': 'expertAppsModal',
    'active-experts': 'activeExpertsModal',
    'expert-history': 'expertHistoryModal',
    'reports': 'reportsModal',
    'reported-accounts': 'reportedAccountsModal',
    'ai-blocks': 'aiBlocksModal'
};

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

function updateAdminSectionSummaries(applications, expertsResult, historyResult, userReportedLen, aiTotal) {
    const pending = applications.filter((a) => String(a.status || 'pending').toLowerCase() === 'pending').length;
    const totalApps = applications.length;
    const badgeApps = document.getElementById('expertAppsBadge');
    if (badgeApps) badgeApps.textContent = pending;

    const badgeActive = document.getElementById('activeExpertsBadge');
    if (badgeActive) badgeActive.textContent = expertsResult?.count ?? 0;

    const badgeHist = document.getElementById('expertHistoryBadge');
    if (badgeHist) badgeHist.textContent = historyResult?.count ?? 0;

    const badgeRep = document.getElementById('reportsBadge');
    if (badgeRep) badgeRep.textContent = userReportedLen;

    const badgeAi = document.getElementById('aiBlocksBadge');
    if (badgeAi) badgeAi.textContent = aiTotal;

    const histStat = document.getElementById('expertApprovedHistoryCount');
    if (histStat) histStat.textContent = String(historyResult?.count ?? 0);
}

// ─── Orchestrate full dashboard refresh ──────────────────────────────────────

async function loadAdminDashboard() {
    flaggedRowsById.clear();

    await purgeExpiredUserReports();
    await purgeExpiredReportedAccounts();

    const [applications, expertsResult, historyResult, flaggedResult, aiData, reportedAccountsResult, pendingPostsResult] =
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

    document.getElementById('expertPendingCount').textContent = String(
        applications.filter((a) => String(a.status || 'pending').toLowerCase().trim() === 'pending').length
    );
    const activeCountEl = document.getElementById('activeExpertsCount');
    if (activeCountEl) activeCountEl.textContent = String(expertsResult?.count ?? 0);
    document.getElementById('pendingPostsCount').textContent = String(pendingPosts.length);
    document.getElementById('reportedCount').textContent = String(userReported.length);
    const aiCountEl = document.getElementById('aiBlockAttemptCount');
    if (aiCountEl) aiCountEl.textContent = String(aiData.total);

    // Update card badges
    const pendingPostsBadge = document.getElementById('pendingPostsBadge');
    if (pendingPostsBadge) pendingPostsBadge.textContent = pendingPosts.length;
    
    const reportedAccountsBadge = document.getElementById('reportedAccountsBadge');
    if (reportedAccountsBadge) reportedAccountsBadge.textContent = reportedAccountsResult?.count ?? 0;

    updateAdminSectionSummaries(applications, expertsResult, historyResult, userReported.length, aiData.total);

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

    document.getElementById('adminDashboardRoot')?.addEventListener('click', (e) => {
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
        const { data, error } = await supabase
            .from('reported_accounts')
            .select('id, reported_user_id, reporter_id, reason, details, status, created_at')
            .order('created_at', { ascending: false })
            .limit(80);
        if (error) throw error;
        return { rows: data || [], errorMessage: '' };
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

        showAppAlert('Post Rejected', 'The post has been rejected and the student has been notified.', 'success');
        await loadAdminDashboard();
    } catch (err) {
        console.error('Error rejecting post:', err);
        showAppAlert('Error', 'Failed to reject post. Please try again.', 'error');
    }
}

function renderReportedAccountsSection(result) {
    const container = document.getElementById('reportedAccountsList');
    const sumEl = document.getElementById('summaryReportedAccounts');
    if (!container) return;
    if (result?.errorMessage) {
        if (sumEl) sumEl.textContent = '—';
        container.innerHTML = `<p class="empty">Could not load reported accounts: ${escapeHtml(result.errorMessage)}</p>`;
        return;
    }
    const rows = result?.rows || [];
    if (sumEl) sumEl.textContent = `${rows.length} in list`;
    if (!rows.length) {
        container.innerHTML = '<p class="empty">No reported accounts yet.</p>';
        return;
    }
    container.innerHTML = rows
        .map(
            (r) => `
            <article class="row">
                <p class="row-title">Reported user <code>${escapeHtml(r.reported_user_id)}</code></p>
                <p class="row-meta">${escapeHtml(formatDate(r.created_at))} · Reporter: <code>${escapeHtml(r.reporter_id)}</code> · ${formatFlagStatusBadge(r.status)}</p>
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
