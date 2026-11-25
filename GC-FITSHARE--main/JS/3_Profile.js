/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 3_Profile.js — USER PROFILE (own or others via ?user=uuid)
 * ═══════════════════════════════════════════════════════════════════════════ 
 * 
 * PURPOSE
 *   Profile data, edit modal, avatar upload, posts tab, bookmarks, follows,  
 *   expert endorsements on cards, comments on profile posts.
 *
 * DEPENDS ON
 *   0_Utilities.js, 0_Footer.js (showAppAlert), 0_Alerts.js.
 *
 * SECTIONS (search for `// ───` in this file)
 *   Init | Load Profile | Display Profile | Load User Posts | Post Card
 *   Save Profile | Avatar | Tabs | Follow lists | Event Listeners
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */


if (new URLSearchParams(window.location.search).get('view') === 'directory') {
  document.documentElement.classList.add('directory-profile-view');
}
let supabase;
let currentUser  = null;
let userProfile  = null;
let viewedUserId = null;
let isOwnProfile = true;
let isFollowingViewedUser = false;
let followsFeatureAvailable = true;
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
let profileViewerIsExpert = false;
let profileViewerIsAdmin = false;
let profileExpertWeeklyRemaining = 0;
let profileSetupRequired = false;
let profileSetupPhase = null;
/** public.admins user_ids; merged with users.is_admin for badges */
let profileAdminUserIdSet = new Set();

async function refreshProfileExpertQuota() {
    profileViewerIsExpert = false;
    profileViewerIsAdmin = false;
    profileExpertWeeklyRemaining = 0;
    if (!currentUser?.id) return;
    const { data: me } = await supabase
        .from('users')
        .select('is_expert, is_admin')
        .eq('id', currentUser.id)
        .maybeSingle();
    profileViewerIsExpert = !!me?.is_expert;
    profileViewerIsAdmin = !!me?.is_admin;
    if (!profileViewerIsAdmin && currentUser?.id) {
        const { data: adm } = await supabase
            .from('admins')
            .select('id')
            .eq('user_id', currentUser.id)
            .maybeSingle();
        profileViewerIsAdmin = !!adm?.id;
    }
    if (profileViewerIsExpert && typeof countExpertEndorsementsThisWeek === 'function') {
        const used = await countExpertEndorsementsThisWeek(supabase, currentUser.id);
        const lim = typeof getExpertWeeklyEndorsementLimit === 'function' ? getExpertWeeklyEndorsementLimit() : 3;
        profileExpertWeeklyRemaining = Math.max(0, lim - used);
    }
}

/** Attach author row to post for cards; fills is_expert from profile when DB omits it for the viewed user. */
function mergeLoadedPostUser(post, postUser) {
    const adminFromRoster = (userId, rowFlag) =>
        typeof mergeIsAdminFlag === 'function'
            ? mergeIsAdminFlag(userId, !!rowFlag, profileAdminUserIdSet)
            : !!rowFlag;
    if (postUser) {
        post.user = {
            ...postUser,
            is_expert: !!(postUser.is_expert) || (post.user_id === viewedUserId && !!userProfile?.is_expert),
            is_admin:
                adminFromRoster(post.user_id, postUser.is_admin) ||
                (post.user_id === viewedUserId && !!userProfile?.is_admin)
        };
    } else if (post.user_id === viewedUserId && userProfile) {
        post.user = {
            id: userProfile.id,
            full_name: userProfile.full_name,
            username: userProfile.username,
            course: userProfile.course,
            avatar_url: userProfile.avatar_url,
            is_expert: !!userProfile.is_expert,
            is_admin: !!userProfile.is_admin
        };
    } else {
        post.user = null;
    }
}

function resolveProfileAvatarUrl(avatarUrl) {
    const raw = avatarUrl ? String(avatarUrl).trim() : '';
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;

    const storagePrefix = /^\/?storage\/v1\/object\/public\/profile-pictures\//i;
    if (storagePrefix.test(raw)) {
        return `${SUPABASE_URL}/storage/v1/object/public/profile-pictures/${encodeURI(raw.replace(storagePrefix, ''))}`;
    }

    const path = raw.replace(/^profile-pictures\//i, '');
    if (!path.startsWith('profiles/')) return '';
    const { data } = supabase?.storage?.from('profile-pictures').getPublicUrl(path) || {};
    return data?.publicUrl || '';
}

/** Category preferences: canonical column is content_interests; older rows may still have interested_categories. */
function wellnessInterestList(wp) {
    if (!wp) return [];
    if (Array.isArray(wp.content_interests)) return wp.content_interests;
    if (Array.isArray(wp.interested_categories)) return wp.interested_categories;
    return [];
}

const VISIBILITY_STORAGE_PREFIX = 'gcfitshare_profile_visibility_';
const BIRTHDAY_STORAGE_PREFIX = 'gcfitshare_profile_birthday_';
const DEFAULT_PROFILE_VISIBILITY = {
    course: 'public',
    bio: 'public',
    age: 'private',
    birthday: 'private',
    height: 'private',
    weight: 'private',
    email: 'private'
};

const CATEGORY_META = {
    nutrition:       { label: 'Nutrition',       color: '#FF6B6B' },
    fitness:         { label: 'Fitness',         color: '#4ECDC4' },
    mental_wellness: { label: 'Mental Wellness', color: '#95E1D3' },
    productivity:    { label: 'Productivity',    color: '#FFE66D' }
};

const GOAL_LABELS = {
    weight_loss: 'Weight Loss',
    muscle_gain: 'Muscle Gain',
    stress_management: 'Stress Management',
    better_sleep: 'Better Sleep',
    endurance: 'Endurance',
    flexibility: 'Flexibility'
};

/** Normalize JSONB personality_snapshot from Supabase */
function parseWellnessPersonalitySnapshot(raw) {
    if (raw == null) return {};
    if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
        try {
            const o = JSON.parse(raw);
            return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
        } catch {
            return {};
        }
    }
    return {};
}

let userWellnessProfile = null;

function getCategoryBadge(categoryId) {
    const cat = CATEGORY_META[categoryId];
    if (!cat) return '';
    return `<span class="category-badge" style="background:${cat.color}20;color:${cat.color};border:1px solid ${cat.color}40;">${cat.label}</span>`;
}

function normalizeProfileVisibility(raw) {
    const out = { ...DEFAULT_PROFILE_VISIBILITY };
    let obj = raw;
    if (typeof obj === 'string') {
        try { obj = JSON.parse(obj); } catch { obj = {}; }
    }
    if (!obj || typeof obj !== 'object') return out;
    Object.keys(out).forEach((k) => {
        if (obj[k] === 'public' || obj[k] === 'private') out[k] = obj[k];
    });
    if (obj.profile_setup_stage === 'lifestyle' || obj.profile_setup_stage === 'complete') {
        out.profile_setup_stage = obj.profile_setup_stage;
    }
    return out;
}

function loadVisibilityFromStorage(userId) {
    try {
        const s = localStorage.getItem(VISIBILITY_STORAGE_PREFIX + userId);
        if (!s) return null;
        return normalizeProfileVisibility(JSON.parse(s));
    } catch {
        return null;
    }
}

function saveVisibilityToStorage(userId, vis) {
    localStorage.setItem(VISIBILITY_STORAGE_PREFIX + userId, JSON.stringify(vis));
}

function loadBirthdayFromStorage(userId) {
    try {
        return localStorage.getItem(BIRTHDAY_STORAGE_PREFIX + userId) || '';
    } catch {
        return '';
    }
}

function saveBirthdayToStorage(userId, birthdayValue) {
    try {
        if (birthdayValue) {
            localStorage.setItem(BIRTHDAY_STORAGE_PREFIX + userId, birthdayValue);
        } else {
            localStorage.removeItem(BIRTHDAY_STORAGE_PREFIX + userId);
        }
    } catch {
        // ignore storage failures
    }
}

function mergeProfileVisibility(profile) {
    const fromLocal = loadVisibilityFromStorage(profile.id) || {};
    let fromDb = profile.profile_visibility || {};
    if (typeof fromDb === 'string') {
        try {
            fromDb = JSON.parse(fromDb);
        } catch {
            fromDb = {};
        }
    }
    return normalizeProfileVisibility({
        ...DEFAULT_PROFILE_VISIBILITY,
        ...fromLocal,
        ...fromDb
    });
}

function canShowField(key) {
    const vis = mergeProfileVisibility(userProfile);
    return isOwnProfile || vis[key] === 'public';
}

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    supabase    = getSupabaseClient();
    currentUser = await checkUserAuthentication();
    if (currentUser) {
        if (await redirectIncompleteProfileSetup(currentUser)) return;
        await ensureUserExists(currentUser);
        // Keep the edit modal outside the profile section's overflow clipping.
        const editProfileModal = document.getElementById('editProfileModal');
        if (editProfileModal) document.body.appendChild(editProfileModal);
        viewedUserId = getViewedUserIdFromUrl() || currentUser.id;
        isOwnProfile = viewedUserId === currentUser.id;
        applyProfileViewMode();
        await loadUserProfile();
        setupEventListeners();
        await beginRequiredProfileSetup();
    }
});

function getViewedUserIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('user');
}

async function beginRequiredProfileSetup() {
    if (!isOwnProfile || !currentUser?.id) return;

    const status = await getRequiredProfileSetupStatus(currentUser);
    if (!status.checked || !status.required) return;

    profileSetupRequired = true;
    profileSetupPhase = status.phase || 'profile';
    setRequiredProfileSetupControls(true);
    openEditProfileModal(profileSetupPhase === 'lifestyle' ? 'lifestyle' : 'edit');
    showAppAlert(
        'Complete your profile',
        profileSetupPhase === 'lifestyle'
            ? 'Save your Lifestyle & For You preferences to finish setup.'
            : 'Add a username and course before setting up Lifestyle & For You.',
        'info'
    );
}

function setRequiredProfileSetupControls(required) {
    const closeButton = document.getElementById('closeEditProfileModal');
    const cancelButton = document.getElementById('cancelEditProfile');
    const lifestyleCloseButton = document.getElementById('closeLifestyleProfileModal');
    const lifestyleCancelButton = document.getElementById('cancelLifestyleProfile');
    const usernameInput = document.getElementById('editUsername');
    const courseInput = document.getElementById('editCourse');

    if (closeButton) {
        closeButton.hidden = required;
        closeButton.disabled = required;
    }
    if (cancelButton) {
        cancelButton.hidden = required;
        cancelButton.disabled = required;
    }
    if (lifestyleCloseButton) {
        lifestyleCloseButton.hidden = required;
        lifestyleCloseButton.disabled = required;
    }
    if (lifestyleCancelButton) {
        lifestyleCancelButton.hidden = required;
        lifestyleCancelButton.disabled = required;
    }
    if (usernameInput) usernameInput.required = required;
    if (courseInput) courseInput.required = required;
}

function blockIncompleteProfileNavigation(event) {
    if (!profileSetupRequired) return;
    event.preventDefault();
    const message = profileSetupPhase === 'lifestyle'
        ? 'Save your Lifestyle & For You preferences before leaving this page.'
        : 'Save a username and course before leaving this page.';
    showAppAlert('Profile setup required', message, 'info');
}

// ─── Load Profile ─────────────────────────────────────────────────────────────
async function loadUserProfile() {
    try {
        const { data, error } = await supabase
            .from('users')
            .select('*')
            .eq('id', viewedUserId)
            .single();

        if (error && error.code !== 'PGRST116') {
            console.error('Error loading profile:', error);
        }

        userProfile = data || {
            id:           viewedUserId,
            email:        currentUser.email,
            username:     isOwnProfile ? (currentUser.email?.split('@')[0] || 'User') : 'GC Student',
            full_name:    '',
            bio:          '',
            course:       '',
            age:          null,
            birthday:     '',
            height:       null,
            weight:       null,
            avatar_url:   null,
            role:         'student',
            is_expert:    false,
            is_admin:     false,
            is_suspended: false
        };

        userProfile.profile_visibility = mergeProfileVisibility(userProfile);
        if (isOwnProfile && !userProfile.birthday) {
            userProfile.birthday = loadBirthdayFromStorage(currentUser.id);
        }

        profileAdminUserIdSet =
            typeof fetchAdminUserIdsSet === 'function' ? await fetchAdminUserIdsSet(supabase) : new Set();
        if (userProfile.id && typeof mergeIsAdminFlag === 'function') {
            userProfile.is_admin = mergeIsAdminFlag(userProfile.id, !!userProfile.is_admin, profileAdminUserIdSet);
        }

        await loadWellnessProfile();
        displayUserProfile();
        await loadUserPosts();
        await loadBookmarkedPosts();
        await loadFollowersList();
        await loadFollowingList();
        await loadFollowStats();
        await loadFollowState();

    } catch (err) {
        console.error('Profile loading error:', err);
    }
}

async function loadWellnessProfile() {
    userWellnessProfile = null;
    try {
        const { data, error } = await supabase
            .from('wellness_profiles')
            .select(
                'user_id, fitness_goals, content_interests, bio, activity_level, health_preferences, personality_snapshot, experience_story, interested_categories'
            )
            .eq('user_id', viewedUserId)
            .maybeSingle();
        if (error) throw error;
        userWellnessProfile = data || null;
    } catch (err) {
        console.warn('Wellness profile unavailable:', err?.message || err);
    }
}

function formatBirthday(isoDate) {
    if (!isoDate) return '';
    const parsed = new Date(isoDate);
    if (Number.isNaN(parsed.getTime())) return isoDate;
    return parsed.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function renderWellnessSummary() {
    const el = document.getElementById('wellnessSummary');
    if (!el) return;
    const interests = wellnessInterestList(userWellnessProfile);
    const goals = Array.isArray(userWellnessProfile?.fitness_goals) ? userWellnessProfile.fitness_goals : [];
    const bio = (userWellnessProfile?.bio || '').trim();

    const snap = parseWellnessPersonalitySnapshot(userWellnessProfile?.personality_snapshot);
    const quizAnswered = ['motivation', 'training_vibe', 'social_energy', 'learning_style'].filter((k) => snap[k]).length;
    const hasPrivateNotes = !!(userWellnessProfile?.experience_story || '').trim();

    if (!interests.length && !goals.length && !bio) {
        el.innerHTML = isOwnProfile
            ? `<p class="profile-details-hint">Your wellness interests and goals appear here for others when you mark them public. Open <strong>Edit Profile</strong> to choose categories and goals. Use <strong>Lifestyle &amp; For You</strong> (or the same section inside edit) for the lifestyle quiz and optional private notes that shape your <strong>For You</strong> feed.</p>
                ${quizAnswered || hasPrivateNotes ? `<p class="profile-details-hint" style="margin-top:8px;">Feed personalization: lifestyle quiz ${quizAnswered}/4${hasPrivateNotes ? ', private notes saved' : ''}.</p>` : ''}`
            : '';
        return;
    }

    const interestBadges = interests.map((id) => getCategoryBadge(id)).join('');
    const goalsText = goals.map((g) => GOAL_LABELS[g] || g).join(', ');
    const feedHint =
        isOwnProfile && (quizAnswered > 0 || hasPrivateNotes)
            ? `<div class="wellness-feed-hint">For You ranking: lifestyle quiz ${quizAnswered}/4${hasPrivateNotes ? ' · private notes enabled' : ''}.</div>`
            : '';

    el.innerHTML = `
        <div class="wellness-summary-title">Wellness Preferences</div>
        ${interestBadges ? `<div class="post-category">${interestBadges}</div>` : ''}
        ${goalsText ? `<div class="wellness-summary-goals"><strong>Goals:</strong> ${escapeHtml(goalsText)}</div>` : ''}
        ${bio ? `<div class="wellness-summary-bio">${escapeHtml(bio)}</div>` : ''}
        ${feedHint}
    `;
}

async function loadFollowStats() {
    const fc = document.getElementById('followersCount');
    const fg = document.getElementById('followingCount');
    if (!fc || !fg) return;

    try {
        const { count: followers, error: followersError } = await supabase
            .from('follows')
            .select('*', { count: 'exact', head: true })
            .eq('following_id', viewedUserId);
        if (followersError) throw followersError;

        const { count: following, error: followingError } = await supabase
            .from('follows')
            .select('*', { count: 'exact', head: true })
            .eq('follower_id', viewedUserId);
        if (followingError) throw followingError;

        fc.textContent = String(followers || 0);
        fg.textContent = String(following || 0);
        followsFeatureAvailable = true;
    } catch (err) {
        followsFeatureAvailable = false;
        fc.textContent = '—';
        fg.textContent = '—';
        console.warn('Follows table unavailable or inaccessible:', err?.message || err);
    }
}

async function loadFollowState() {
    const followBtn = document.getElementById('followToggleBtn');
    if (!followBtn) return;

    if (isOwnProfile) {
        followBtn.style.display = 'none';
        return;
    }

    if (!followsFeatureAvailable) {
        followBtn.style.display = 'inline-flex';
        followBtn.classList.remove('following');
        followBtn.textContent = 'Follow Unavailable';
        followBtn.disabled = true;
        return;
    }

    try {
        const { data, error } = await supabase
            .from('follows')
            .select('id')
            .eq('follower_id', currentUser.id)
            .eq('following_id', viewedUserId)
            .maybeSingle();
        if (error) throw error;
        isFollowingViewedUser = !!data;
        setFollowButtonState();
    } catch (err) {
        followsFeatureAvailable = false;
        followBtn.style.display = 'inline-flex';
        followBtn.classList.remove('following');
        followBtn.textContent = 'Follow Unavailable';
        followBtn.disabled = true;
    }
}

function setFollowButtonState(isBusy = false) {
    const followBtn = document.getElementById('followToggleBtn');
    if (!followBtn) return;

    if (isOwnProfile) {
        followBtn.style.display = 'none';
        return;
    }

    followBtn.style.display = 'inline-flex';
    followBtn.disabled = isBusy || !followsFeatureAvailable;

    if (!followsFeatureAvailable) {
        followBtn.classList.remove('following');
        followBtn.textContent = 'Follow Unavailable';
        return;
    }

    if (isFollowingViewedUser) {
        followBtn.classList.add('following');
        followBtn.textContent = isBusy ? 'Updating...' : 'Unfollow';
    } else {
        followBtn.classList.remove('following');
        followBtn.textContent = isBusy ? 'Updating...' : 'Follow';
    }
}

async function handleFollowToggle() {
    if (isOwnProfile || !followsFeatureAvailable) return;
    setFollowButtonState(true);

    try {
        if (isFollowingViewedUser) {
            const { error } = await supabase
                .from('follows')
                .delete()
                .eq('follower_id', currentUser.id)
                .eq('following_id', viewedUserId);
            if (error) throw error;
            isFollowingViewedUser = false;
        } else {
            const { error } = await supabase
                .from('follows')
                .insert({
                    follower_id: currentUser.id,
                    following_id: viewedUserId
                });
            if (error) throw error;
            isFollowingViewedUser = true;
            await createFollowNotification(viewedUserId);
        }

        await loadFollowStats();
        if (isOwnProfile) {
            await loadFollowersList();
            await loadFollowingList();
        }
    } catch (err) {
        console.error('Follow toggle error:', err);
        const msg = String(err?.message || '').toLowerCase();
        const code = String(err?.code || '');
        const likelySetupIssue =
            code === '42P01' ||
            code === '42501' ||
            msg.includes('relation') ||
            msg.includes('follows') ||
            msg.includes('permission denied');

        if (likelySetupIssue) {
            followsFeatureAvailable = false;
            await loadFollowStats();
            setFollowButtonState(false);
            showAppAlert('Setup Required', 'Follow setup is not complete yet. Run SQL/002_create_follows_table.sql in Supabase SQL Editor, then refresh.', 'error');
            return;
        }

        showAppAlert('Follow Update Failed', `Unable to update follow status right now.\n\n${err?.message || ''}`, 'error');
    } finally {
        setFollowButtonState(false);
    }
}

async function createFollowNotification(targetUserId) {
    if (!targetUserId || targetUserId === currentUser?.id) return;
    try {
        let actorName = currentUser?.user_metadata?.full_name || '';
        if (!actorName) {
            const { data: actorRow } = await supabase
                .from('users')
                .select('full_name, username, email')
                .eq('id', currentUser.id)
                .maybeSingle();
            actorName = actorRow?.full_name || actorRow?.username || actorRow?.email?.split('@')?.[0] || 'Someone';
        }
        const { error } = await supabase
            .from('notifications')
            .insert({
                recipient_id: targetUserId,
                actor_id: currentUser.id,
                type: 'follow',
                title: 'New follower',
                message: `${actorName} started following you.`,
                is_read: false
            });
        if (error) throw error;
    } catch (err) {
        // Keep follow action successful even if notifications setup is missing.
        console.warn('Follow notification insert skipped:', err?.message || err);
    }
}

// ─── Display Profile ──────────────────────────────────────────────────────────
let reportUserTargetId = null;

function setProfilePictureFromUser() {
    const picImg = document.getElementById('profilePicture');
    const picInitials = document.getElementById('profilePictureInitials');
    if (!picImg || !picInitials || !userProfile) return;
    const nameSrc = userProfile.full_name || userProfile.username || 'GC';
    const ini = nameSrc.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2) || 'GC';
    picInitials.textContent = ini;
    const url = resolveProfileAvatarUrl(userProfile.avatar_url);
    if (url) {
        picImg.src = url;
        picImg.classList.remove('hidden');
        picInitials.classList.add('hidden');
    } else {
        picImg.removeAttribute('src');
        picImg.classList.add('hidden');
        picInitials.classList.remove('hidden');
    }
}

function openReportUserModal() {
    if (!viewedUserId || viewedUserId === currentUser?.id) {
        showAppAlert('Report', 'You cannot report your own account.', 'error');
        return;
    }
    reportUserTargetId = viewedUserId;
    const modal = document.getElementById('reportUserModal');
    if (modal) modal.classList.add('active');
}

function closeReportUserModal() {
    reportUserTargetId = null;
    const modal = document.getElementById('reportUserModal');
    if (modal) modal.classList.remove('active');
    const r = document.getElementById('reportUserReason');
    const d = document.getElementById('reportUserDetails');
    if (r) r.value = '';
    if (d) d.value = '';
}

async function submitReportedUser() {
    const reason = document.getElementById('reportUserReason')?.value?.trim();
    const details = document.getElementById('reportUserDetails')?.value?.trim() || '';
    if (!reportUserTargetId || reportUserTargetId === currentUser?.id) {
        showAppAlert('Report', 'You cannot report your own account.', 'error');
        return;
    }
    if (!reason) {
        showAppAlert('Report', 'Please select a reason.', 'error');
        return;
    }
    const submitBtn = document.getElementById('submitReportUserBtn');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting…';
    }
    const summary = details ? `${reason}: ${details}` : reason;
    try {
        const { error } = await supabase.from('reported_accounts').insert({
            reported_user_id: reportUserTargetId,
            reporter_id: currentUser.id,
            reason: summary,
            details: details || null,
            status: 'pending'
        });
        if (error) throw error;
        showAppAlert('Thanks', 'Your report was submitted.', 'success');
        closeReportUserModal();
    } catch (err) {
        console.error('Report user error:', err);
        if (typeof notifyAllAdmins === 'function') {
            await notifyAllAdmins({
                type: 'admin_reported_account',
                title: 'User report (needs DB setup or retry)',
                message: `Reporter ${currentUser.id} reported user ${reportUserTargetId}. Reason: ${summary}. Error: ${String(err?.message || err)}. If this repeats, run SQL/013_reported_accounts.sql in Supabase.`
            });
        }
        showAppAlert(
            'Report',
            'We could not save the report in the database, but administrators were notified. If this keeps happening, ensure the reported_accounts table exists (see SQL/013_reported_accounts.sql).',
            'warning'
        );
        closeReportUserModal();
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Submit report';
        }
    }
}

function displayUserProfile() {
    document.getElementById('displayName').textContent =
        userProfile.full_name || userProfile.username || 'No name set';

    const expertSlot = document.getElementById('profileExpertBadgeSlot');
    if (expertSlot) {
        if (userProfile.is_expert) {
            if (typeof getExpertUserBadgeSvg === 'function') {
                expertSlot.innerHTML = getExpertUserBadgeSvg(userProfile.id, 26);
            } else {
                expertSlot.innerHTML =
                    '<span class="expert-badge-fallback" title="Wellness expert">Expert</span>';
            }
            expertSlot.hidden = false;
        } else {
            expertSlot.innerHTML = '';
            expertSlot.hidden = true;
        }
    }

    const adminSlot = document.getElementById('profileAdminBadgeSlot');
    if (adminSlot) {
        if (userProfile.is_admin) {
            if (typeof getAdminUserBadgeHtml === 'function') {
                adminSlot.innerHTML = getAdminUserBadgeHtml(`prof-${userProfile.id}`, 26);
            } else {
                adminSlot.innerHTML =
                    '<span class="admin-badge-fallback" title="Administrator">Admin</span>';
            }
            adminSlot.hidden = false;
        } else {
            adminSlot.innerHTML = '';
            adminSlot.hidden = true;
        }
    }

    const expertRoleEl = document.getElementById('profileExpertRoleLabel');
    if (expertRoleEl) {
        if (userProfile.is_admin) {
            expertRoleEl.textContent = 'Admin';
            expertRoleEl.className = 'profile-expert-role-label role-admin';
        } else if (userProfile.is_expert) {
            expertRoleEl.textContent = 'Verified Expert';
            expertRoleEl.className = 'profile-expert-role-label role-expert';
        } else {
            expertRoleEl.textContent = 'Student';
            expertRoleEl.className = 'profile-expert-role-label role-student';
        }
        expertRoleEl.hidden = false;
    }

    const courseEl = document.getElementById('userCourse');
    const bioEl = document.getElementById('userBio');
    const detailsEl = document.getElementById('profileDetails');

    if (isOwnProfile || canShowField('course')) {
        courseEl.textContent = userProfile.course || 'Course not set';
    } else {
        courseEl.textContent = '—';
    }

    if (isOwnProfile || canShowField('bio')) {
        bioEl.textContent = userProfile.bio || 'No bio yet';
    } else {
        bioEl.textContent = '—';
    }

    setProfilePictureFromUser();

    const reportUserBtn = document.getElementById('reportUserBtn');
    if (reportUserBtn) {
        reportUserBtn.style.display = !isOwnProfile && currentUser ? 'inline-flex' : 'none';
    }

    const pageTitle = document.querySelector('.page-title');
    if (pageTitle) {
        pageTitle.textContent = isOwnProfile ? 'Profile' : 'User Profile';
    }

    const myPostsTabBtn = document.querySelector('.tab-btn[data-tab="my-posts"]');
    if (myPostsTabBtn) {
        myPostsTabBtn.textContent = isOwnProfile ? 'My Posts' : 'Posts';
    }

    if (detailsEl) {
        const vis = mergeProfileVisibility(userProfile);
        const email = userProfile.email || (isOwnProfile ? currentUser.email : '');
        const detailRows = [];
        if (email && (isOwnProfile || vis.email === 'public')) {
            detailRows.push({
                label: 'Email',
                value: email,
                pill: isOwnProfile ? `<span class="profile-detail-pill ${vis.email === 'public' ? 'is-public' : 'is-private'}">${vis.email === 'public' ? 'Public' : 'Private'}</span>` : ''
            });
        }
        if (userProfile.age != null && userProfile.age !== '' && (isOwnProfile || vis.age === 'public')) {
            detailRows.push({
                label: 'Age',
                value: String(userProfile.age),
                pill: isOwnProfile ? `<span class="profile-detail-pill ${vis.age === 'public' ? 'is-public' : 'is-private'}">${vis.age === 'public' ? 'Public' : 'Private'}</span>` : ''
            });
        } else if (isOwnProfile && userProfile.age != null && userProfile.age !== '') {
            detailRows.push({
                label: 'Age',
                value: String(userProfile.age),
                pill: `<span class="profile-detail-pill is-private">Private</span>`
            });
        }
        if (userProfile.birthday && (isOwnProfile || vis.birthday === 'public')) {
            detailRows.push({
                label: 'Birthday',
                value: formatBirthday(userProfile.birthday),
                pill: isOwnProfile ? `<span class="profile-detail-pill ${vis.birthday === 'public' ? 'is-public' : 'is-private'}">${vis.birthday === 'public' ? 'Public' : 'Private'}</span>` : ''
            });
        } else if (isOwnProfile && userProfile.birthday) {
            detailRows.push({
                label: 'Birthday',
                value: formatBirthday(userProfile.birthday),
                pill: `<span class="profile-detail-pill is-private">Private</span>`
            });
        }
        if (userProfile.height != null && userProfile.height !== '' && (isOwnProfile || vis.height === 'public')) {
            detailRows.push({
                label: 'Height',
                value: `${userProfile.height} cm`,
                pill: isOwnProfile ? `<span class="profile-detail-pill ${vis.height === 'public' ? 'is-public' : 'is-private'}">${vis.height === 'public' ? 'Public' : 'Private'}</span>` : ''
            });
        } else if (isOwnProfile && userProfile.height != null && userProfile.height !== '') {
            detailRows.push({
                label: 'Height',
                value: `${userProfile.height} cm`,
                pill: `<span class="profile-detail-pill is-private">Private</span>`
            });
        }
        if (userProfile.weight != null && userProfile.weight !== '' && (isOwnProfile || vis.weight === 'public')) {
            detailRows.push({
                label: 'Weight',
                value: `${userProfile.weight} kg`,
                pill: isOwnProfile ? `<span class="profile-detail-pill ${vis.weight === 'public' ? 'is-public' : 'is-private'}">${vis.weight === 'public' ? 'Public' : 'Private'}</span>` : ''
            });
        } else if (isOwnProfile && userProfile.weight != null && userProfile.weight !== '') {
            detailRows.push({
                label: 'Weight',
                value: `${userProfile.weight} kg`,
                pill: `<span class="profile-detail-pill is-private">Private</span>`
            });
        }

        if (!detailRows.length) {
            detailsEl.innerHTML = isOwnProfile
                ? '<p class="profile-details-hint">Add age, height, or weight in Edit Profile to show them here.</p>'
                : '';
        } else {
            detailsEl.innerHTML = detailRows.map(r => `
                <div class="profile-detail-row">
                    <span class="profile-detail-label">${escapeHtml(r.label)}</span>
                    <span class="profile-detail-value">${escapeHtml(r.value)}</span>
                    ${r.pill || ''}
                </div>`).join('');
        }
    }
    renderWellnessSummary();
}

// ─── Load User Posts + Likes Count ───────────────────────────────────────────
async function loadUserPosts() {
    const container = document.getElementById('myPostsContainer');

    await refreshProfileExpertQuota();

    try {
        const { data: posts, error } = await supabase
            .from('posts')
            .select('id, title, body, image_url, created_at, user_id, category, hashtags, expert_endorsed_at, expert_endorsed_by, is_expert_approved, status')
            .eq('user_id', viewedUserId)
            .order('created_at', { ascending: false });

        if (error) throw error;

        if (typeof mergePostsExpertBadgeFromRpc === 'function') {
            await mergePostsExpertBadgeFromRpc(supabase, posts || []);
        }

        document.getElementById('postCount').textContent = posts?.length || 0;
        container.innerHTML = '';

        if (!posts || !posts.length) {
            container.innerHTML = `
                <div class="empty-state">
                    <p>No posts yet</p>
                    <small>${isOwnProfile ? 'Your posts will appear here' : 'This user has not posted yet'}</small>
                </div>`;
            document.getElementById('likesCount').textContent = 0;
            return;
        }

        let totalLikes = 0;

        for (const post of posts) {
            const { data: postUser } = await supabase
                .from('users')
                .select('id, full_name, username, course, avatar_url, is_expert, is_admin')
                .eq('id', post.user_id)
                .single();
            mergeLoadedPostUser(post, postUser);

            // upvotes for this post
            const { count: upvotes } = await supabase
                .from('votes')
                .select('*', { count: 'exact', head: true })
                .eq('post_id', post.id)
                .eq('vote_type', 'up');   // FIX: 'up' not 'upvote'

            const { count: downvotes } = await supabase
                .from('votes')
                .select('*', { count: 'exact', head: true })
                .eq('post_id', post.id)
                .eq('vote_type', 'down');

            const { count: commentCount } = await supabase
                .from('comments')
                .select('*', { count: 'exact', head: true })
                .eq('post_id', post.id)
                .eq('is_deleted', false);

            const postUpvotes = upvotes || 0;
            totalLikes += postUpvotes;

            container.innerHTML += createPostCard({ ...post, downvotes_count: downvotes || 0 }, postUpvotes, commentCount || 0, isOwnProfile);
        }
        
        // Attach event listeners to all buttons after DOM is updated
        attachPostCardListeners();
        await markSavedBookmarksOnProfile();

        // wire up the total likes stat in the profile header
        document.getElementById('likesCount').textContent = totalLikes;

    } catch (err) {
        console.error('Error loading posts:', err);
        container.innerHTML = `<div class="empty-state"><p>Error loading posts</p></div>`;
    }
}

// ─── Attach Event Listeners to Post Cards ─────────────────────────────────────
function attachPostCardListeners() {
    document.querySelectorAll('.post-card').forEach((card) => {
        if (card.dataset.detailClickBound === '1') return;
        card.dataset.detailClickBound = '1';
        card.style.cursor = 'pointer';
        card.addEventListener('click', (e) => {
            if (e.target.closest('button, a, input, textarea, select, .post-comments, .menu-dropdown')) return;
            const postId = card.getAttribute('data-post-id');
            if (postId) void openProfilePostDetail(postId);
        });
    });

    // Delete buttons
    document.querySelectorAll('.delete-post-btn').forEach(btn => {
        btn.removeEventListener('click', handleDeleteClick);
        btn.addEventListener('click', handleDeleteClick);
    });
    
    // Read more buttons
    document.querySelectorAll('.read-more-btn').forEach(btn => {
        btn.removeEventListener('click', handleReadMoreClick);
        btn.addEventListener('click', handleReadMoreClick);
    });

    document.querySelectorAll('.comment-btn').forEach(btn => {
        btn.removeEventListener('click', handleToggleCommentsClick);
        btn.addEventListener('click', handleToggleCommentsClick);
    });

    document.querySelectorAll('.upvote-btn').forEach(btn => {
        btn.addEventListener('click', () => handleVoteClick(btn.dataset.postId, 'up', btn.closest('.post-card')));
    });

    document.querySelectorAll('.downvote-btn').forEach(btn => {
        btn.addEventListener('click', () => handleVoteClick(btn.dataset.postId, 'down', btn.closest('.post-card')));
    });

    document.querySelectorAll('.bookmark-btn').forEach(btn => {
        btn.addEventListener('click', () => toggleBookmark(btn.dataset.postId, btn.closest('.post-card')));
    });

    document.querySelectorAll('.menu-toggle').forEach(btn => {
        btn.addEventListener('click', togglePostMenu);
    });

    document.querySelectorAll('.share-btn').forEach(btn => {
        btn.addEventListener('click', (e) => sharePost(e, btn.dataset.postId));
    });

    document.querySelectorAll('.expert-endorse-btn').forEach((btn) => {
        btn.removeEventListener('click', handleExpertEndorseMenuClick);
        btn.addEventListener('click', handleExpertEndorseMenuClick);
    });
}

async function handleExpertEndorseMenuClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const btn = e.currentTarget;
    const postId = btn.getAttribute('data-post-id');
    const card = btn.closest('.post-card');
    const ownerId = card?.getAttribute('data-post-owner-id') || '';
    document.querySelectorAll('.menu-dropdown.active').forEach((m) => m.classList.remove('active'));
    if (!postId || typeof tryExpertEndorsePost !== 'function') return;

    btn.disabled = true;
    const result = await tryExpertEndorsePost(supabase, {
        expertUserId: currentUser.id,
        postId,
        postOwnerId: ownerId
    });
    btn.disabled = false;

    if (!result.ok) {
        showAppAlert('Expert approve', result.error || 'Something went wrong.', 'error');
        return;
    }

    profileExpertWeeklyRemaining = result.weeklyRemaining ?? profileExpertWeeklyRemaining;

    if (typeof getPostExpertApprovedBadgeHtml === 'function' && card) {
        const wrap = document.createElement('div');
        wrap.innerHTML = getPostExpertApprovedBadgeHtml(postId);
        const strip = wrap.firstElementChild;
        const catEl = card.querySelector('.post-category');
        const titleEl = card.querySelector('.post-title');
        if (catEl && strip) catEl.after(strip);
        else if (titleEl && strip) titleEl.before(strip);
        else if (strip) card.querySelector('.post-header')?.after(strip);
    }

    btn.remove();
    card?.querySelector('.expert-endorse-disabled')?.remove();

    const lim = typeof getExpertWeeklyEndorsementLimit === 'function' ? getExpertWeeklyEndorsementLimit() : 3;
    document.querySelectorAll('.expert-endorse-btn').forEach((b) => {
        if (profileExpertWeeklyRemaining < 1) {
            const dis = document.createElement('button');
            dis.type = 'button';
            dis.className = 'menu-item expert-endorse-disabled';
            dis.disabled = true;
            dis.textContent = `Expert approve (0/${lim} — resets Monday)`;
            b.replaceWith(dis);
        } else {
            b.textContent = `Expert approve (${profileExpertWeeklyRemaining}/${lim} this week)`;
        }
    });

    showAppAlert('Thank you', 'Expert approval saved for this post.', 'success');
}

function handleDeleteClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const postId = this.getAttribute('data-post-id');
    deleteMyPost(postId);
}

function handleReadMoreClick(e) {
    const postCard = this.closest('.post-card');
    const postId = postCard.getAttribute('data-post-id');
    if (postId) void openProfilePostDetail(postId);
}

async function openProfilePostDetail(postId) {
    try {
        const { data: post, error } = await supabase
            .from('posts')
            .select('id, title, body, image_url, created_at, user_id, category, hashtags, expert_endorsed_at, expert_endorsed_by, is_expert_approved, status')
            .eq('id', postId)
            .maybeSingle();
        if (error) throw error;
        if (!post) return;

        const [userResult, upvotesResult, downvotesResult, commentsResult, bookmarkResult] = await Promise.all([
            supabase.from('users').select('id, full_name, username, course, avatar_url, is_expert, is_admin').eq('id', post.user_id).maybeSingle(),
            supabase.from('votes').select('*', { count: 'exact', head: true }).eq('post_id', post.id).eq('vote_type', 'up'),
            supabase.from('votes').select('*', { count: 'exact', head: true }).eq('post_id', post.id).eq('vote_type', 'down'),
            supabase.from('comments').select('*', { count: 'exact', head: true }).eq('post_id', post.id).eq('is_deleted', false),
            currentUser?.id
                ? supabase.from('bookmarks').select('id').eq('user_id', currentUser.id).eq('post_id', post.id).maybeSingle()
                : Promise.resolve({ data: null, error: null })
        ]);

        mergeLoadedPostUser(post, userResult.data);
        viewFullPost(post, {
            upvotes: upvotesResult.count || 0,
            downvotes: downvotesResult.count || 0,
            comments: commentsResult.count || 0,
            isBookmarked: Boolean(bookmarkResult.data)
        });
    } catch (error) {
        console.error('Post detail error:', error);
    }
}

async function handleToggleCommentsClick() {
    const postId = this.getAttribute('data-post-id');
    const modal = this.closest('.full-post-modal');
    const section = modal?.querySelector(`.post-comments[data-post-id="${postId}"]`) ||
        document.querySelector(`.post-comments[data-post-id="${postId}"]`);
    const container = section?.querySelector('.comments-container');
    if (!section || !container) return;

    const isHidden = section.style.display === 'none' || !section.style.display;
    if (!isHidden) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';
    container.innerHTML = '<small>Loading comments...</small>';

    try {
        const { data: comments, error } = await supabase
            .from('comments')
            .select('id, body, created_at, user_id, user:user_id(full_name, username, is_expert, is_admin)')
            .eq('post_id', postId)
            .eq('is_deleted', false)
            .order('created_at', { ascending: true });

        if (error) throw error;

        const commentAdminSet =
            typeof fetchAdminUserIdsSet === 'function' ? await fetchAdminUserIdsSet(supabase) : new Set();
        if (typeof mergeIsAdminFlag === 'function') {
            (comments || []).forEach((c) => {
                if (!c.user) return;
                c.user.is_admin = mergeIsAdminFlag(c.user_id, !!c.user.is_admin, commentAdminSet);
            });
        }

        let postingBlocked = false;
        let postingBlockedMsg = '';
        if (currentUser && typeof checkPostingAllowed === 'function') {
            const pc = await checkPostingAllowed(supabase, currentUser.id);
            if (!pc.allowed) {
                postingBlocked = true;
                postingBlockedMsg =
                    pc.message || 'Your account cannot post comments right now.';
            }
        }

        const commentFormHtml =
            currentUser && !postingBlocked
                ? `
            <div class="comment-form" style="display:flex;gap:8px;margin:0 0 12px 0;">
                <input type="text" class="comment-input" id="profile-comment-input-${postId}"
                    placeholder="Write a comment..." maxlength="500" style="flex:1;padding:8px 10px;border:1px solid #dfe6e9;border-radius:8px;">
                <button type="button" class="btn-primary profile-comment-submit-btn" data-post-id="${postId}" style="padding:8px 12px;">Comment</button>
            </div>
        `
                : currentUser && postingBlocked
                  ? `<p style="color:#f39c12;font-size:13px;margin:0 0 12px 0;line-height:1.45;padding:8px 10px;border-radius:8px;background:rgba(243,156,18,0.12);">${escapeHtml(postingBlockedMsg)} You can still read comments below.</p>`
                  : '';

        const commentsHtml = (!comments || comments.length === 0)
            ? '<small>No comments yet.</small>'
            : comments.map((c) => {
                const expertHere =
                    !!(c.user?.is_expert) ||
                    (c.user_id === currentUser?.id && profileViewerIsExpert);
                const adminHere =
                    !!(c.user?.is_admin) ||
                    (c.user_id === currentUser?.id && profileViewerIsAdmin);
                const cExpert =
                    expertHere && typeof getExpertUserBadgeSvg === 'function'
                        ? getExpertUserBadgeSvg(`pf-${postId}-${c.id}`, 16)
                        : expertHere
                          ? '<span class="expert-badge-fallback">Expert</span>'
                          : '';
                const cAdmin =
                    adminHere && typeof getAdminUserBadgeHtml === 'function'
                        ? getAdminUserBadgeHtml(`pf-${postId}-${c.id}`, 16)
                        : adminHere
                          ? '<span class="admin-badge-fallback">Admin</span>'
                          : '';
                return `
                <div class="comment-item" style="margin-bottom:10px;">
                    <strong>${escapeHtml(c.user?.full_name || c.user?.username || 'GC Student')}</strong>${cExpert}${cAdmin}
                    <small style="color:#888;margin-left:6px;">${new Date(c.created_at).toLocaleDateString()}</small>
                    <p style="margin:4px 0 0 0;">${escapeHtml(c.body || '')}</p>
                </div>`;
            }).join('');

        container.innerHTML = `${commentFormHtml}<div class="profile-comments-list">${commentsHtml}</div>`;
        container.querySelector('.profile-comment-submit-btn')?.addEventListener('click', () => {
            submitProfileComment(postId, container);
        });
    } catch (err) {
        console.error('Error loading profile post comments:', err);
        container.innerHTML = '<small>Error loading comments.</small>';
    }
}

async function submitProfileComment(postId, commentsContainer = null) {
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
                    `${msg}\n\nThis applies while your account is restricted.`,
                    'warning'
                );
            } else {
                showAppAlert('Comments restricted', msg, 'error');
            }
            return;
        }
    }

    const input = commentsContainer?.querySelector(`#profile-comment-input-${postId}`) ||
        document.getElementById(`profile-comment-input-${postId}`);
    const content = input?.value?.trim() || '';
    if (!content) {
        showAppAlert('Missing Comment', 'Please write a comment.', 'error');
        return;
    }

    try {
        if (typeof analyzeContentWithGemini === 'function') {
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
                    showAppAlert(
                        'Moderation unavailable',
                        'We could not scan your comment right now. Please try again in a few minutes.',
                        'error'
                    );
                } else {
                    showAppAlert(
                        'Comment blocked',
                        moderationResult.reason || 'This comment does not meet community guidelines.',
                        'error'
                    );
                }
                return;
            }
        }

        const { error } = await supabase
            .from('comments')
            .insert({
                post_id: postId,
                user_id: currentUser.id,
                body: content
            });
        if (error) throw error;

        if (input) input.value = '';
        document.querySelectorAll(`.post-card[data-post-id="${postId}"] .comment-count`).forEach((countEl) => {
            const current = parseInt(countEl.textContent || '0', 10);
            countEl.textContent = String(current + 1);
        });

        const modal = commentsContainer?.closest('.full-post-modal');
        const triggerBtn = modal?.querySelector('.comment-btn') ||
            document.querySelector(`.post-card[data-post-id="${postId}"] .comment-btn`);
        const section = modal?.querySelector(`.post-comments[data-post-id="${postId}"]`);
        if (section) section.style.display = 'none';
        if (triggerBtn) await handleToggleCommentsClick.call(triggerBtn);
    } catch (err) {
        console.error('Profile comment submit error:', err);
        showAppAlert('Comment Failed', 'Failed to post comment. Please try again.', 'error');
    }
}

// ─── Post Card (matches Main Feed markup / SVGs) ─────────────────────────────
function buildPostAvatarHtml(user, initials) {
    const url = resolveProfileAvatarUrl(user?.avatar_url);
    if (url) {
        return `<img class="post-avatar post-avatar-img" src="${escapeHtml(url)}" alt="" width="45" height="45" loading="lazy" referrerpolicy="no-referrer">`;
    }
    return `<div class="post-avatar post-avatar-fallback">${escapeHtml(initials)}</div>`;
}

function createPostCard(post, upvotes = 0, commentCount = 0, canDelete = false) {
    const date = new Date(post.created_at).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
    });

    const MAX_PREVIEW_LENGTH = 300;
    const bodyPreview = post.body ? post.body.substring(0, MAX_PREVIEW_LENGTH) : '';
    const hasMore = post.body && post.body.length > MAX_PREVIEW_LENGTH;

    const displayName = post.user?.full_name || post.user?.username || userProfile.full_name || userProfile.username || 'GC Student';
    const initials = displayName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || 'GC';
    const postAvatarHtml = buildPostAvatarHtml(post.user, initials);
    const course = post.user?.course || '';
    const isExpert = post.user_id === viewedUserId
        ? !!(post.user?.is_expert ?? userProfile?.is_expert)
        : !!(post.user?.is_expert);
    const isAdminUser = post.user_id === viewedUserId
        ? !!(post.user?.is_admin ?? userProfile?.is_admin)
        : !!(post.user?.is_admin);
    const hashtagsHTML = post.hashtags
        ? String(post.hashtags).split(' ').filter(Boolean).map(tag => `<span class="hashtag">${escapeHtml(tag)}</span>`).join('')
        : '';

    const category = post.category || '';
    const downvotes = post.downvotes_count ?? 0;
    const expertLim = typeof getExpertWeeklyEndorsementLimit === 'function' ? getExpertWeeklyEndorsementLimit() : 3;
    const expertUserBadge = isExpert && typeof getExpertUserBadgeSvg === 'function'
        ? getExpertUserBadgeSvg(post.id)
        : (isExpert ? '<span class="expert-badge-fallback">Expert</span>' : '');
    const adminUserBadge = isAdminUser && typeof getAdminUserBadgeHtml === 'function'
        ? getAdminUserBadgeHtml(`pc-${post.id}`)
        : (isAdminUser ? '<span class="admin-badge-fallback">Admin</span>' : '');
    const postHasExpertBadge =
        !!(post.expert_endorsed_at || post.is_expert_approved);
    const expertApprovedStrip =
        postHasExpertBadge && typeof getPostExpertApprovedBadgeHtml === 'function'
            ? getPostExpertApprovedBadgeHtml(post.id)
            : '';
    const isOwnPostCard = post.user_id === currentUser?.id;
    const showExpertEndorseActive =
        profileViewerIsExpert && !isOwnPostCard && !postHasExpertBadge && profileExpertWeeklyRemaining > 0;
    const showExpertEndorseDisabled =
        profileViewerIsExpert && !isOwnPostCard && !postHasExpertBadge && profileExpertWeeklyRemaining <= 0;
    const expertEndorseMenuActive = showExpertEndorseActive
        ? `<button type="button" class="menu-item expert-endorse-btn" data-post-id="${post.id}">Expert approve (${profileExpertWeeklyRemaining}/${expertLim} this week)</button>`
        : '';
    const expertEndorseMenuDisabled = showExpertEndorseDisabled
        ? `<button type="button" class="menu-item expert-endorse-disabled" disabled>Expert approve (0/${expertLim} — resets Monday)</button>`
        : '';
    const postStatus = post.status || 'published';
    const statusBadge = postStatus === 'pending' ? '<span class="post-status-badge pending">Pending Approval</span>' : 
                       postStatus === 'rejected' ? '<span class="post-status-badge rejected">Rejected</span>' : '';

    return `
        <div class="post-card" data-post-id="${post.id}" data-post-owner-id="${post.user_id || ''}">
            <div class="post-header">
                <div class="post-author-info">
                    ${postAvatarHtml}
                    <div class="post-author-details">
                        <div class="post-author-name">
                            ${escapeHtml(displayName)}
                            ${expertUserBadge}
                            ${adminUserBadge}
                        </div>
                        <div class="post-author-course">${escapeHtml(course)}</div>
                    </div>
                </div>
                <div class="post-date">${date}</div>
                <div class="post-menu">
                    <button class="post-action-btn menu-toggle" type="button" title="More options">⋯</button>
                    <div class="menu-dropdown">
                        <button type="button" class="menu-item share-btn" data-post-id="${post.id}">Share</button>
                        ${expertEndorseMenuActive}
                        ${expertEndorseMenuDisabled}
                        ${canDelete ? `<button type="button" class="menu-item delete-post-btn" data-post-id="${post.id}" style="color:#e74c3c;">Delete Post</button>` : ''}
                    </div>
                </div>
            </div>
            ${category ? `<div class="post-category">${getCategoryBadge(category)}</div>` : ''}
            ${statusBadge}
            ${expertApprovedStrip}
            ${post.title ? `<h3 class="post-title">${escapeHtml(post.title)}</h3>` : ''}
            ${post.image_url ? `<img src="${post.image_url}" alt="Post image" class="post-image">` : ''}
            ${bodyPreview ? `<p class="post-body">${escapeHtml(bodyPreview)}${hasMore ? '...' : ''}</p>` : ''}
            ${hasMore ? `<button type="button" class="read-more-btn" data-post-id="${post.id}">Read more</button>` : ''}
            ${hashtagsHTML ? `<div class="post-hashtags">${hashtagsHTML}</div>` : ''}
            <div class="post-footer">
                <div class="post-voting">
                    <button type="button" class="vote-btn upvote-btn" data-post-id="${post.id}" title="Upvote">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                            <polyline points="18 15 12 9 6 15"></polyline>
                        </svg>
                        <span class="upvote-count">${upvotes}</span>
                    </button>
                    <button type="button" class="vote-btn downvote-btn" data-post-id="${post.id}" title="Downvote">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                            <polyline points="6 9 12 15 18 9"></polyline>
                        </svg>
                        <span class="downvote-count">${downvotes}</span>
                    </button>
                </div>
                <div class="post-right-actions">
                    <button type="button" class="post-action-btn comment-btn" data-post-id="${post.id}" title="Comment">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                        </svg>
                        <span class="comment-count">${commentCount}</span>
                    </button>
                    <button type="button" class="post-action-btn bookmark-btn" data-post-id="${post.id}" title="Bookmark">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
                        </svg>
                    </button>
                </div>
            </div>
            <div class="post-comments" data-post-id="${post.id}" style="display: none;">
                <div class="comments-container"></div>
            </div>
        </div>`;
}

function togglePostMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    const dropdown = e.target.closest('.post-menu')?.querySelector('.menu-dropdown');
    if (!dropdown) return;
    document.querySelectorAll('.menu-dropdown.active').forEach(m => {
        if (m !== dropdown) m.classList.remove('active');
    });
    dropdown.classList.toggle('active');
}

async function sharePost(e, postId) {
    e.preventDefault();
    const shareUrl = `${window.location.origin}/HTML/2_Main_Feed.html#post-${postId}`;
    try {
        await navigator.clipboard.writeText(shareUrl);
        showNotification('Post link copied to clipboard!');
    } catch {
        showAppAlert('Copy Link Failed', 'Unable to copy link. Please copy manually: ' + shareUrl, 'error');
    }
}

async function handleVoteClick(postId, voteType, cardEl) {
    if (!cardEl || !currentUser) return;
    try {
        let shouldNotifyPostLike = false;
        const { data: existing } = await supabase
            .from('votes')
            .select('id, vote_type')
            .eq('post_id', postId)
            .eq('user_id', currentUser.id)
            .single();

        if (existing) {
            if (existing.vote_type === voteType) {
                await supabase.from('votes').delete().eq('id', existing.id);
            } else {
                await supabase.from('votes').update({ vote_type: voteType }).eq('id', existing.id);
                shouldNotifyPostLike = voteType === 'up';
            }
        } else {
            await supabase.from('votes').insert({
                post_id: postId,
                user_id: currentUser.id,
                vote_type: voteType
            });
            shouldNotifyPostLike = voteType === 'up';
        }

        const { count: up } = await supabase
            .from('votes')
            .select('*', { count: 'exact', head: true })
            .eq('post_id', postId)
            .eq('vote_type', 'up');
        const { count: down } = await supabase
            .from('votes')
            .select('*', { count: 'exact', head: true })
            .eq('post_id', postId)
            .eq('vote_type', 'down');

        cardEl.querySelector('.upvote-count').textContent = up || 0;
        cardEl.querySelector('.downvote-count').textContent = down || 0;

        if (shouldNotifyPostLike) {
            await createPostLikeNotificationFromProfile(postId, cardEl);
        }
    } catch (error) {
        console.error('Vote error:', error);
    }
}

async function createPostLikeNotificationFromProfile(postId, cardEl) {
    try {
        if (!currentUser?.id || !postId) return;

        let targetUserId = cardEl?.getAttribute('data-post-owner-id') || null;
        let postTitle = cardEl?.querySelector('.post-title')?.textContent?.trim() || '';

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
            recipient_id: targetUserId,
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
        console.warn('Profile like notification insert skipped:', err?.message || err);
    }
}

async function toggleBookmark(postId, cardEl) {
    if (!cardEl || !currentUser) return;
    const button = cardEl.querySelector('.bookmark-btn');
    const svg = button?.querySelector('svg');
    try {
        const { data: existing } = await supabase
            .from('bookmarks')
            .select('id')
            .eq('user_id', currentUser.id)
            .eq('post_id', postId)
            .single();

        if (existing) {
            await supabase.from('bookmarks').delete().eq('id', existing.id);
            button.classList.remove('bookmarked');
            if (svg) svg.setAttribute('fill', 'none');
        } else {
            await supabase.from('bookmarks').insert({
                user_id: currentUser.id,
                post_id: postId
            });
            button.classList.add('bookmarked');
            if (svg) svg.setAttribute('fill', 'currentColor');
        }
    } catch (error) {
        console.error('Bookmark toggle error:', error);
    }
}

async function markSavedBookmarksOnProfile() {
    if (!currentUser) return;
    try {
        const { data: bookmarks } = await supabase
            .from('bookmarks')
            .select('post_id')
            .eq('user_id', currentUser.id);
        if (!bookmarks) return;
        bookmarks.forEach((b) => {
            const card = document.querySelector(`.post-card[data-post-id="${b.post_id}"]`);
            if (!card) return;
            const btn = card.querySelector('.bookmark-btn');
            const svg = btn?.querySelector('svg');
            btn?.classList.add('bookmarked');
            if (svg) svg.setAttribute('fill', 'currentColor');
        });
    } catch (err) {
        console.error('markSavedBookmarksOnProfile:', err);
    }
}

// ─── Delete from Profile ──────────────────────────────────────────────────────
async function deleteMyPost(postId) {
    const success = await deletePost(postId); // from 0_Utilities.js
    if (success) await loadUserPosts();
}

// ─── Save Profile ─────────────────────────────────────────────────────────────
async function saveProfile() {
    const username  = document.getElementById('editUsername').value.trim();
    const full_name = document.getElementById('editFullName')?.value.trim() || '';
    const bio       = document.getElementById('editBio').value.trim();
    const course    = document.getElementById('editCourse').value.trim();
    const age       = document.getElementById('editAge').value;
    const birthday  = document.getElementById('editBirthday')?.value || '';
    const height    = document.getElementById('editHeight').value;
    const weight    = document.getElementById('editWeight').value;
    const wellnessInterests = Array.from(document.querySelectorAll('input[name="profile_content_interests"]:checked')).map(el => el.value);
    const wellnessGoals = Array.from(document.querySelectorAll('input[name="profile_fitness_goals"]:checked')).map(el => el.value);
    const wellnessBio = document.getElementById('editWellnessBio')?.value?.trim() || null;

    if (!username) {
        showAppAlert('Missing Username', 'Username is required', 'error');
        document.getElementById('editUsername')?.focus();
        return;
    }

    if (profileSetupRequired && !course) {
        showAppAlert('Missing Course', 'Course / Program is required', 'error');
        document.getElementById('editCourse')?.focus();
        return;
    }

    userProfile.username  = username;
    userProfile.full_name = full_name;
    userProfile.bio       = bio;
    userProfile.course    = course;
    userProfile.age       = age    ? parseInt(age)      : null;
    userProfile.birthday  = birthday || '';
    userProfile.height    = height ? parseInt(height)   : null;
    userProfile.weight    = weight ? parseFloat(weight) : null;

    userProfile.profile_visibility = normalizeProfileVisibility({
        course: document.getElementById('visCourse')?.value || 'public',
        bio: document.getElementById('visBio')?.value || 'public',
        age: document.getElementById('visAge')?.value || 'private',
        birthday: document.getElementById('visBirthday')?.value || 'private',
        height: document.getElementById('visHeight')?.value || 'private',
        weight: document.getElementById('visWeight')?.value || 'private',
        email: document.getElementById('visEmail')?.value || 'private'
    });
    if (profileSetupRequired) {
        userProfile.profile_visibility.profile_setup_stage = 'lifestyle';
    }

    try {
        await updateUserProfile({ requireProfileSetupStage: profileSetupRequired });
        if (!profileSetupRequired) {
            try {
            await saveWellnessProfile(wellnessInterests, wellnessGoals, wellnessBio);
            } catch (wellnessError) {
                // Wellness preferences remain optional in the normal Edit Profile flow.
                console.warn('Optional wellness preferences were not saved:', wellnessError?.message || wellnessError);
            }
        }
        await loadWellnessProfile();
        displayUserProfile();
        saveBirthdayToStorage(currentUser.id, userProfile.birthday);

        if (profileSetupRequired) {
            closeEditProfileModal({ force: true });
            const url = new URL(window.location.href);
            url.searchParams.set('setup', 'lifestyle');
            window.history.replaceState({}, '', url);
            profileSetupPhase = 'lifestyle';
            openEditProfileModal('lifestyle');
            return;
        }

        closeEditProfileModal();
        showAppAlert('Success', 'Profile updated successfully!', 'success');
    } catch (err) {
        console.error('Save profile error:', err);
        showAppAlert('Save Failed', 'Error saving profile. Please try again.', 'error');
    }
}

// ─── Update in DB ─────────────────────────────────────────────────────────────
async function updateUserProfile(options = {}) {
    const baseUpdate = {
        username:   userProfile.username,
        full_name:  userProfile.full_name,
        bio:        userProfile.bio,
        course:     userProfile.course,
        age:        userProfile.age,
        birthday:   userProfile.birthday || null,
        height:     userProfile.height,
        weight:     userProfile.weight,
        avatar_url: userProfile.avatar_url
    };

    const withVisibility = {
        ...baseUpdate,
        profile_visibility: userProfile.profile_visibility
    };

    const writeProfile = (payload) => supabase
        .from('users')
        .update(payload)
        .eq('id', currentUser.id)
        .select('id')
        .maybeSingle();

    let result = await writeProfile(withVisibility);

    if (result.error || !result.data) {
        if (options.requireProfileSetupStage) {
            throw result.error || new Error('Profile setup status was not saved.');
        }
        let retry = await writeProfile(baseUpdate);
        if (retry.error || !retry.data) {
            const noBirthdayUpdate = { ...baseUpdate };
            delete noBirthdayUpdate.birthday;
            retry = await writeProfile(noBirthdayUpdate);
            if (retry.error || !retry.data) {
                throw retry.error || result.error || new Error('Profile was not saved.');
            }
        }
        saveVisibilityToStorage(currentUser.id, userProfile.profile_visibility);
    } else {
        try {
            localStorage.removeItem(VISIBILITY_STORAGE_PREFIX + currentUser.id);
        } catch { /* ignore */ }
    }
}

async function saveWellnessProfile(interests, goals, bio) {
    if (!currentUser?.id) throw new Error('No authenticated user.');
    const prev = userWellnessProfile || {};
    const personality_snapshot =
        typeof readLifestylePersonalitySnapshot === 'function' ? readLifestylePersonalitySnapshot('profile') : {};
    const experience_story =
        typeof readLifestyleExperienceStory === 'function' ? readLifestyleExperienceStory('profile') : null;
    const payload = {
        user_id: currentUser.id,
        content_interests: Array.isArray(interests) ? interests : [],
        fitness_goals: Array.isArray(goals) ? goals : [],
        bio: bio || null,
        activity_level: prev.activity_level ?? null,
        health_preferences: Array.isArray(prev.health_preferences) ? prev.health_preferences : [],
        personality_snapshot,
        experience_story,
        updated_at: new Date().toISOString()
    };
    const { error } = await supabase
        .from('wellness_profiles')
        .upsert(payload, { onConflict: 'user_id' });
    if (error) throw error;
}

// ─── Avatar Upload ────────────────────────────────────────────────────────────
async function handleProfilePictureUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
        showAppAlert('Upload Failed', 'File must be under 2MB', 'error');
        return;
    }
    if (!file.type.startsWith('image/')) {
        showAppAlert('Invalid File', 'Please select an image', 'error');
        return;
    }

    try {
        const ext      = file.name.split('.').pop();
        const filePath = `profiles/${currentUser.id}-${Date.now()}.${ext}`;

        const { error: uploadError } = await supabase.storage
            .from('profile-pictures')
            .upload(filePath, file, { upsert: true });
        if (uploadError) throw uploadError;

        const { data: urlData } = supabase.storage.from('profile-pictures').getPublicUrl(filePath);
        userProfile.avatar_url = urlData.publicUrl;
        setProfilePictureFromUser();
        await updateUserProfile();
    } catch (err) {
        console.error('Avatar upload error:', err);
        showAppAlert('Upload Failed', 'Error uploading picture. Please try again.', 'error');
    }
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function ensureLifestyleModal() {
    if (document.getElementById('lifestyleProfileModal')) return;
    const editModal = document.getElementById('editProfileModal');
    const body = editModal?.querySelector('.modal-body');
    if (!body) return;
    const modal = document.createElement('div');
    modal.id = 'lifestyleProfileModal';
    modal.className = 'modal';
    modal.innerHTML = `<div class="modal-content profile-modal lifestyle-profile-modal">
      <div class="modal-header"><h2>Lifestyle &amp; For You</h2><button type="button" class="close-modal" id="closeLifestyleProfileModal" aria-label="Close">&times;</button></div>
      <div class="modal-body lifestyle-profile-body"></div>
      <div class="modal-footer"><button type="button" class="btn-cancel" id="cancelLifestyleProfile">Cancel</button><button type="button" class="btn-save" id="saveLifestyleProfile">Save Preferences</button></div>
    </div>`;
    const lifestyleBody = modal.querySelector('.lifestyle-profile-body');
    body.querySelectorAll('.wellness-edit-group, .privacy-notice').forEach((section) => lifestyleBody.appendChild(section));
    document.body.appendChild(modal);
}

function openEditProfileModal(mode = 'edit') {
    document.getElementById('editUsername').value = userProfile.username  || '';
    document.getElementById('editBio').value      = userProfile.bio       || '';
    document.getElementById('editCourse').value   = userProfile.course    || '';
    document.getElementById('editAge').value      = userProfile.age       || '';
    const birthdayInput = document.getElementById('editBirthday');
    if (birthdayInput) birthdayInput.value = userProfile.birthday || '';
    document.getElementById('editHeight').value   = userProfile.height    || '';
    document.getElementById('editWeight').value   = userProfile.weight    || '';
    const fn = document.getElementById('editFullName');
    if (fn) fn.value = userProfile.full_name || '';
    const vis = mergeProfileVisibility(userProfile);
    const setVis = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val === 'public' ? 'public' : 'private';
    };
    setVis('visCourse', vis.course);
    setVis('visBio', vis.bio);
    setVis('visAge', vis.age);
    setVis('visBirthday', vis.birthday);
    setVis('visHeight', vis.height);
    setVis('visWeight', vis.weight);
    setVis('visEmail', vis.email);
    const em = document.getElementById('editEmail');
    if (em) em.value = userProfile.email || currentUser.email || '';
    const interests = wellnessInterestList(userWellnessProfile);
    const goals = Array.isArray(userWellnessProfile?.fitness_goals) ? userWellnessProfile.fitness_goals : [];
    document.querySelectorAll('input[name="profile_content_interests"]').forEach((cb) => {
        cb.checked = interests.includes(cb.value);
    });
    document.querySelectorAll('input[name="profile_fitness_goals"]').forEach((cb) => {
        cb.checked = goals.includes(cb.value);
    });
    const wellnessBioInput = document.getElementById('editWellnessBio');
    if (wellnessBioInput) wellnessBioInput.value = userWellnessProfile?.bio || '';
    const snap = parseWellnessPersonalitySnapshot(userWellnessProfile?.personality_snapshot);
    const setSel = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val || '';
    };
    setSel('profilePersonalityMotivation', snap.motivation);
    setSel('profilePersonalityTraining', snap.training_vibe);
    setSel('profilePersonalitySocial', snap.social_energy);
    setSel('profilePersonalityLearning', snap.learning_style);
    const expEl = document.getElementById('profileExperienceStory');
    if (expEl) expEl.value = userWellnessProfile?.experience_story || '';
    updateBioCharCount();
    const target = mode === 'lifestyle' ? document.getElementById('lifestyleProfileModal') : document.getElementById('editProfileModal');
    target?.classList.add('active');
}

function closeEditProfileModal(options = {}) {
    if (profileSetupRequired && !options.force) {
        const message = profileSetupPhase === 'lifestyle'
            ? 'Save your Lifestyle & For You preferences before continuing.'
            : 'Save a username and course before continuing.';
        showAppAlert('Profile setup required', message, 'info');
        return;
    }
    document.getElementById('editProfileModal').classList.remove('active');
    document.getElementById('lifestyleProfileModal')?.classList.remove('active');
}

async function saveLifestylePreferences() {
    const interests = Array.from(document.querySelectorAll('input[name="profile_content_interests"]:checked')).map((el) => el.value);
    const goals = Array.from(document.querySelectorAll('input[name="profile_fitness_goals"]:checked')).map((el) => el.value);
    const bio = document.getElementById('editWellnessBio')?.value?.trim() || null;
    try {
        await saveWellnessProfile(interests, goals, bio);
        if (profileSetupRequired) {
            userProfile.profile_visibility = {
                ...normalizeProfileVisibility(userProfile.profile_visibility),
                profile_setup_stage: 'complete'
            };
            await updateUserProfile({ requireProfileSetupStage: true });
            profileSetupRequired = false;
            profileSetupPhase = 'complete';
            setRequiredProfileSetupControls(false);
            const url = new URL(window.location.href);
            url.searchParams.delete('setup');
            window.history.replaceState({}, '', url);
        }
        await loadWellnessProfile();
        closeEditProfileModal({ force: true });
        displayUserProfile();
        showAppAlert('Success', 'Lifestyle preferences updated.', 'success');
    } catch (err) {
        console.error('Lifestyle preferences save error:', err);
        showAppAlert('Save Failed', 'Lifestyle preferences could not be saved. Please try again.', 'error');
    }
}

function updateBioCharCount() {
    const len = document.getElementById('editBio').value.length;
    document.getElementById('bioCharCount').textContent = `${len}/250`;
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function switchTab(e) {
    const tabName = e.target.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    e.target.classList.add('active');
    document.getElementById(tabName)?.classList.add('active');
}

// ─── Logout ───────────────────────────────────────────────────────────────────
async function handleLogout() {
    const { error } = await supabase.auth.signOut();
    if (error) { console.error('Logout error:', error); return; }
    window.location.href = '/HTML/1_LogIn_Page.html';
}

// Dark mode — handled by 0_Footer.js via toggleDarkMode()

// escapeHtml() defined in 0_Utilities.js

async function loadBookmarkedPosts() {
    const container = document.getElementById('bookmarkedPostsContainer');
    if (!isOwnProfile) {
        const tabBtn = document.querySelector('.tab-btn[data-tab="bookmarks"]');
        const tabContent = document.getElementById('bookmarks');
        if (tabBtn) tabBtn.style.display = 'none';
        if (tabContent) {
            tabContent.innerHTML = `
                <div class="empty-state">
                    <p>Bookmarks are private</p>
                    <small>You can only view bookmarks on your own profile.</small>
                </div>`;
        }
        const bookmarkCount = document.getElementById('bookmarkCount');
        if (bookmarkCount) bookmarkCount.textContent = '—';
        return;
    }

    try {
        await refreshProfileExpertQuota();

        const { data: bookmarks, error } = await supabase
            .from('bookmarks')
            .select(`post_id, posts (id, title, body, image_url, created_at, user_id, category, hashtags, expert_endorsed_at, expert_endorsed_by, is_expert_approved)`)
            .eq('user_id', currentUser.id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        document.getElementById('bookmarkCount').textContent = bookmarks?.length || 0;
        container.innerHTML = '';

        if (!bookmarks || !bookmarks.length) {
            container.innerHTML = `
                <div class="empty-state">
                    <p>No bookmarks yet</p>
                    <small>Tap the bookmark icon on any post to save it here</small>
                </div>`;
            return;
        }

        const bookmarkPosts = bookmarks.map((b) => b.posts).filter(Boolean);
        if (typeof mergePostsExpertBadgeFromRpc === 'function') {
            await mergePostsExpertBadgeFromRpc(supabase, bookmarkPosts);
        }

        for (const b of bookmarks) {
            if (!b.posts) continue;
            const post = b.posts;
            const { data: postUser } = await supabase
                .from('users')
                .select('id, full_name, username, course, avatar_url, is_expert, is_admin')
                .eq('id', post.user_id)
                .single();
            mergeLoadedPostUser(post, postUser);

            const { count: upvotes } = await supabase
                .from('votes')
                .select('*', { count: 'exact', head: true })
                .eq('post_id', post.id)
                .eq('vote_type', 'up');

            const { count: downvotes } = await supabase
                .from('votes')
                .select('*', { count: 'exact', head: true })
                .eq('post_id', post.id)
                .eq('vote_type', 'down');

            const { count: comments } = await supabase
                .from('comments')
                .select('*', { count: 'exact', head: true })
                .eq('post_id', post.id)
                .eq('is_deleted', false);

            container.innerHTML += createPostCard({ ...post, downvotes_count: downvotes || 0 }, upvotes || 0, comments || 0, false);
        }
        
        // Attach event listeners to all buttons after DOM is updated
        attachPostCardListeners();
        await markSavedBookmarksOnProfile();

    } catch (err) {
        console.error('Bookmarks error:', err);
        container.innerHTML = `<div class="empty-state"><p>Error loading bookmarks</p></div>`;
    }
}

async function loadFollowingList() {
    const tabBtn = document.querySelector('.tab-btn[data-tab="following-list"]');
    const container = document.getElementById('followingListContainer');
    if (!container) return;

    if (!isOwnProfile) {
        if (tabBtn) tabBtn.style.display = 'none';
        container.innerHTML = `
            <div class="empty-state">
                <p>Following list is private</p>
                <small>You can only view this on your own profile.</small>
            </div>`;
        return;
    }

    if (tabBtn) tabBtn.style.display = '';

    try {
        const { data, error } = await supabase
            .from('follows')
            .select(`
                following_id,
                created_at,
                following:following_id (
                    id,
                    full_name,
                    username,
                    course,
                    avatar_url,
                    is_expert,
                    is_admin
                )
            `)
            .eq('follower_id', currentUser.id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        if (!data || !data.length) {
            container.innerHTML = `
                <div class="empty-state">
                    <p>You are not following anyone yet</p>
                    <small>When you follow users, they will appear here.</small>
                </div>`;
            return;
        }

        container.innerHTML = data.map((row) => {
            const u = row.following;
            if (!u) return '';

            const name = u.full_name || u.username || 'GC Student';
            const initials = name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2) || 'GC';
            const subtitle = `${u.username ? '@' + u.username : 'GC Student'}${u.course ? ' • ' + u.course : ''}`;
            const expertBadge = u.is_expert && typeof getExpertUserBadgeSvg === 'function'
                ? getExpertUserBadgeSvg(u.id, 18)
                : (u.is_expert ? ' • Expert' : '');
            const uIsAdmin =
                typeof mergeIsAdminFlag === 'function'
                    ? mergeIsAdminFlag(u.id, !!u.is_admin, profileAdminUserIdSet)
                    : !!u.is_admin;
            const adminBadge = uIsAdmin && typeof getAdminUserBadgeHtml === 'function'
                ? getAdminUserBadgeHtml(`fol-${u.id}`, 18)
                : (uIsAdmin ? ' • Admin' : '');

            const avatarHtml = u.avatar_url
                ? `<img class="following-user-avatar" src="${escapeHtml(u.avatar_url)}" alt="${escapeHtml(name)}">`
                : `<div class="following-user-avatar fallback">${escapeHtml(initials)}</div>`;

            return `
                <div class="following-user-card">
                    <div class="following-user-info">
                        ${avatarHtml}
                        <div class="following-user-meta">
                            <div class="following-user-name">${escapeHtml(name)}${expertBadge}${adminBadge}</div>
                            <div class="following-user-sub">${escapeHtml(subtitle)}</div>
                        </div>
                    </div>
                    <button class="following-view-btn" data-user-id="${u.id}">View Profile</button>
                </div>`;
        }).join('');

        container.querySelectorAll('.following-view-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const userId = btn.getAttribute('data-user-id');
                if (!userId) return;
                if (userId === currentUser.id) {
                    window.location.href = '/HTML/3_Profile.html';
                } else {
                    window.location.href = `/HTML/3_Profile.html?user=${encodeURIComponent(userId)}`;
                }
            });
        });
    } catch (err) {
        console.error('Following list error:', err);
        container.innerHTML = `
            <div class="empty-state">
                <p>Unable to load following list</p>
                <small>Make sure follows setup is completed in Supabase.</small>
            </div>`;
    }
}

async function loadFollowersList() {
    const tabBtn = document.querySelector('.tab-btn[data-tab="followers-list"]');
    const container = document.getElementById('followersListContainer');
    if (!container) return;

    if (!isOwnProfile) {
        if (tabBtn) tabBtn.style.display = 'none';
        container.innerHTML = `
            <div class="empty-state">
                <p>Followers list is private</p>
                <small>You can only view this on your own profile.</small>
            </div>`;
        return;
    }

    if (tabBtn) tabBtn.style.display = '';

    try {
        const { data, error } = await supabase
            .from('follows')
            .select(`
                follower_id,
                created_at,
                follower:follower_id (
                    id,
                    full_name,
                    username,
                    course,
                    avatar_url,
                    is_expert,
                    is_admin
                )
            `)
            .eq('following_id', currentUser.id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        if (!data || !data.length) {
            container.innerHTML = `
                <div class="empty-state">
                    <p>No followers yet</p>
                    <small>People who follow you will appear here.</small>
                </div>`;
            return;
        }

        container.innerHTML = data.map((row) => {
            const u = row.follower;
            if (!u) return '';

            const name = u.full_name || u.username || 'GC Student';
            const initials = name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2) || 'GC';
            const subtitle = `${u.username ? '@' + u.username : 'GC Student'}${u.course ? ' • ' + u.course : ''}`;
            const expertBadge = u.is_expert && typeof getExpertUserBadgeSvg === 'function'
                ? getExpertUserBadgeSvg(u.id, 18)
                : (u.is_expert ? ' • Expert' : '');
            const uIsAdmin =
                typeof mergeIsAdminFlag === 'function'
                    ? mergeIsAdminFlag(u.id, !!u.is_admin, profileAdminUserIdSet)
                    : !!u.is_admin;
            const adminBadge = uIsAdmin && typeof getAdminUserBadgeHtml === 'function'
                ? getAdminUserBadgeHtml(`folw-${u.id}`, 18)
                : (uIsAdmin ? ' • Admin' : '');

            const avatarHtml = u.avatar_url
                ? `<img class="following-user-avatar" src="${escapeHtml(u.avatar_url)}" alt="${escapeHtml(name)}">`
                : `<div class="following-user-avatar fallback">${escapeHtml(initials)}</div>`;

            return `
                <div class="following-user-card">
                    <div class="following-user-info">
                        ${avatarHtml}
                        <div class="following-user-meta">
                            <div class="following-user-name">${escapeHtml(name)}${expertBadge}${adminBadge}</div>
                            <div class="following-user-sub">${escapeHtml(subtitle)}</div>
                        </div>
                    </div>
                    <button class="following-view-btn" data-user-id="${u.id}">View Profile</button>
                </div>`;
        }).join('');

        container.querySelectorAll('.following-view-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const userId = btn.getAttribute('data-user-id');
                if (!userId) return;
                if (userId === currentUser.id) {
                    window.location.href = '/HTML/3_Profile.html';
                } else {
                    window.location.href = `/HTML/3_Profile.html?user=${encodeURIComponent(userId)}`;
                }
            });
        });
    } catch (err) {
        console.error('Followers list error:', err);
        container.innerHTML = `
            <div class="empty-state">
                <p>Unable to load followers list</p>
                <small>Make sure follows setup is completed in Supabase.</small>
            </div>`;
    }
}

// ─── View Full Post ───────────────────────────────────────────────────────────
function viewFullPost(post, counts = {}) {
    const modal = document.getElementById('fullPostModal');
    const contentEl = document.getElementById('fullPostContent');
    if (!modal || !contentEl || !post?.id) return;

    const displayName = post.user?.full_name || post.user?.username || 'GC Student';
    const initials = displayName.split(' ').map((name) => name[0]).join('').toUpperCase().slice(0, 2) || 'GC';
    const course = post.user?.course || '';
    const authorIsExpert = !!post.user?.is_expert;
    const authorIsAdmin = !!post.user?.is_admin;
    const expertBadge = authorIsExpert && typeof getExpertUserBadgeSvg === 'function'
        ? getExpertUserBadgeSvg(`profile-full-${post.id}`, 18)
        : (authorIsExpert ? '<span class="expert-badge-fallback">Expert</span>' : '');
    const adminBadge = authorIsAdmin && typeof getAdminUserBadgeHtml === 'function'
        ? getAdminUserBadgeHtml(`profile-full-${post.id}`, 18)
        : (authorIsAdmin ? '<span class="admin-badge-fallback">Admin</span>' : '');
    const expertApprovedBadge = (post.expert_endorsed_at || post.is_expert_approved) && typeof getPostExpertApprovedBadgeHtml === 'function'
        ? getPostExpertApprovedBadgeHtml(`profile-full-${post.id}`)
        : '';
    const bookmarkedClass = counts.isBookmarked ? ' bookmarked' : '';

    contentEl.innerHTML = `
        <div class="full-post-header">
            <div class="post-author-info">
                ${buildPostAvatarHtml(post.user, initials)}
                <div class="post-meta">
                    <div class="post-author"><strong>${escapeHtml(displayName)}</strong>${expertBadge}${adminBadge}${course ? `<span class="post-course">• ${escapeHtml(course)}</span>` : ''}</div>
                    <div class="post-date">${formatDate(post.created_at)}</div>
                </div>
            </div>
            ${post.category ? `<div class="post-category">${getCategoryBadge(post.category)}</div>` : ''}
        </div>
        ${expertApprovedBadge}
        <div class="full-post-body">
            <h3 class="full-post-title">${escapeHtml(post.title || 'Untitled Post')}</h3>
            ${post.image_url ? `<img src="${escapeHtml(post.image_url)}" alt="Post image" class="full-post-image">` : ''}
            <div class="full-post-text">${escapeHtml(post.body || '')}</div>
        </div>
        <div class="full-post-actions">
            <div class="post-actions" data-post-id="${post.id}">
                <button type="button" class="post-action-btn upvote-btn" data-post-id="${post.id}" title="Upvote">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M12 19V5M5 12l7-7 7 7"></path></svg>
                    <span class="upvote-count">${counts.upvotes || 0}</span>
                </button>
                <button type="button" class="post-action-btn downvote-btn" data-post-id="${post.id}" title="Downvote">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M12 5v14M5 12l7 7 7-7"></path></svg>
                    <span class="downvote-count">${counts.downvotes || 0}</span>
                </button>
                <button type="button" class="post-action-btn comment-btn" data-post-id="${post.id}" title="Comment">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                    <span class="comment-count">${counts.comments || 0}</span>
                </button>
                <button type="button" class="post-action-btn bookmark-btn${bookmarkedClass}" data-post-id="${post.id}" title="Bookmark">
                    <svg viewBox="0 0 24 24" fill="${counts.isBookmarked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>
                </button>
            </div>
        </div>
        <div class="full-post-comments">
            <div class="post-comments" data-post-id="${post.id}" style="display:none;">
                <div class="comments-container"></div>
            </div>
        </div>
    `;

    const actionsEl = contentEl.querySelector('.full-post-actions');
    actionsEl?.querySelector('.upvote-btn')?.addEventListener('click', () => handleVoteClick(post.id, 'up', actionsEl));
    actionsEl?.querySelector('.downvote-btn')?.addEventListener('click', () => handleVoteClick(post.id, 'down', actionsEl));
    actionsEl?.querySelector('.bookmark-btn')?.addEventListener('click', () => toggleBookmark(post.id, actionsEl));
    actionsEl?.querySelector('.comment-btn')?.addEventListener('click', function () {
        void handleToggleCommentsClick.call(this);
    });

    modal.classList.add('active');
}

function closeFullPostModal() {
    document.getElementById('fullPostModal').classList.remove('active');
}

// ─── Event Listeners ──────────────────────────────────────────────────────────
function setupEventListeners() {
    ensureLifestyleModal();
    if (isOwnProfile) {
        document.getElementById('editProfileBtn')?.addEventListener('click', openEditProfileModal);
        document.getElementById('lifestyleSetupBtn')?.addEventListener('click', () => openEditProfileModal('lifestyle'));
        document.getElementById('closeEditProfileModal')?.addEventListener('click', closeEditProfileModal);
        document.getElementById('cancelEditProfile')?.addEventListener('click', closeEditProfileModal);
        document.getElementById('saveProfileBtn')?.addEventListener('click', saveProfile);
        document.getElementById('closeLifestyleProfileModal')?.addEventListener('click', closeEditProfileModal);
        document.getElementById('cancelLifestyleProfile')?.addEventListener('click', closeEditProfileModal);
        document.getElementById('saveLifestyleProfile')?.addEventListener('click', saveLifestylePreferences);
        document.getElementById('profilePictureInput')?.addEventListener('change', handleProfilePictureUpload);
    }
    document.getElementById('followToggleBtn')?.addEventListener('click', handleFollowToggle);
    document.getElementById('reportUserBtn')?.addEventListener('click', openReportUserModal);
    document.getElementById('closeReportUserModal')?.addEventListener('click', closeReportUserModal);
    document.getElementById('cancelReportUserBtn')?.addEventListener('click', closeReportUserModal);
    document.getElementById('submitReportUserBtn')?.addEventListener('click', submitReportedUser);
    document.getElementById('reportUserModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'reportUserModal') closeReportUserModal();
    });
    document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', switchTab));
    document.getElementById('editBio')?.addEventListener('input', updateBioCharCount);
    document.getElementById('logoutBtn')?.addEventListener('click', handleLogout);
    document.getElementById('darkModeToggle')?.addEventListener('click', toggleDarkMode);
    document.getElementById('editProfileModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'editProfileModal') closeEditProfileModal();
    });
    document.getElementById('lifestyleProfileModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'lifestyleProfileModal') closeEditProfileModal();
    });
    document.getElementById('fullPostModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'fullPostModal') closeFullPostModal();
    });
    document.getElementById('closeFullPostModal')?.addEventListener('click', closeFullPostModal);

    document.querySelectorAll('.nav-menu a').forEach((link) => {
        link.addEventListener('click', blockIncompleteProfileNavigation);
    });
    document.addEventListener('keydown', (event) => {
        if (profileSetupRequired && event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            const message = profileSetupPhase === 'lifestyle'
                ? 'Save your Lifestyle & For You preferences before continuing.'
                : 'Save a username and course before continuing.';
            showAppAlert('Profile setup required', message, 'info');
        }
    });

    document.addEventListener('click', () => {
        document.querySelectorAll('.menu-dropdown.active').forEach(m => m.classList.remove('active'));
    });
}

function applyProfileViewMode() {
    const editBtn = document.getElementById('editProfileBtn');
    const lifeBtn = document.getElementById('lifestyleSetupBtn');
    const followBtn = document.getElementById('followToggleBtn');
    const editPictureBtn = document.querySelector('.edit-picture-btn');
    const editModal = document.getElementById('editProfileModal');

    if (!isOwnProfile) {
        if (editBtn) editBtn.style.display = 'none';
        if (lifeBtn) lifeBtn.style.display = 'none';
        if (editPictureBtn) editPictureBtn.style.display = 'none';
        if (editModal) editModal.remove();
        if (followBtn) followBtn.style.display = 'inline-flex';
    } else if (followBtn) {
        followBtn.style.display = 'none';
        if (editBtn) editBtn.style.display = 'inline-flex';
        if (lifeBtn) lifeBtn.style.display = 'inline-flex';
        if (editPictureBtn) editPictureBtn.style.display = '';
    }
}
