/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 4_Expert_Application.js — WELLNESS EXPERT APPLICATION FORM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PURPOSE 
 *   Multi-step application, file upload, validation; admins see a locked message.
 *
 * DEPENDS ON
 *   0_Utilities.js, 0_Footer.js (showAppAlert), 0_Alerts.js.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

let supabase;
let currentUser = null;
const MAX_CERT_FILE_SIZE = 5 * 1024 * 1024; // 5MB

// ─── Initialize ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    supabase = getSupabaseClient();
    currentUser = await checkUserAuthentication();

    if (!currentUser) {
        console.warn('Auth unavailable during page init; skipping redirect to avoid logout loops.');
        return;
    }

    const isAdmin = await fetchIsCurrentUserAdmin();
    if (isAdmin) {
        showExpertApplicationAdminLocked();
        return;
    }

    const [existing, userIsExpert] = await Promise.all([
        fetchLatestExpertApplicationForUser(),
        fetchCurrentUserIsExpert()
    ]);

    if (existing && !shouldAllowNewExpertApplication(existing.status, userIsExpert)) {
        showExpertApplicationLocked(existing, userIsExpert);
        return;
    }

    await loadUserData();
    setupFormEventListeners();

    const st = String(existing?.status || '').toLowerCase().trim();
    if (existing && (st === 'approved' || st === 'accepted') && userIsExpert === false) {
        document.getElementById('expertRevokedNotice')?.classList.remove('hidden');
    }
});

/** Application row can stay "approved" after admin revokes expert role — users row is source of truth for active expert status. */
function shouldAllowNewExpertApplication(statusRaw, userIsExpert) {
    const s = String(statusRaw || 'pending').toLowerCase().trim();
    if (s === 'rejected' || s === 'denied') return true;
    if ((s === 'approved' || s === 'accepted') && userIsExpert === false) return true;
    return false;
}

/** @returns {Promise<boolean|null>} Current wellness expert flag, or null if the profile could not be loaded. */
async function fetchCurrentUserIsExpert() {
    if (!currentUser?.id || !supabase) return null;
    try {
        const { data, error } = await supabase
            .from('users')
            .select('is_expert')
            .eq('id', currentUser.id)
            .maybeSingle();
        if (error) {
            console.warn('is_expert lookup (expert page):', error.message || error);
            return null;
        }
        if (!data) return null;
        return !!data.is_expert;
    } catch (err) {
        console.warn('is_expert lookup (expert page):', err);
        return null;
    }
}

async function fetchIsCurrentUserAdmin() {
    if (!currentUser?.id || !supabase) return false;
    try {
        const { data, error } = await supabase
            .from('admins')
            .select('id')
            .eq('user_id', currentUser.id)
            .maybeSingle();
        if (error) {
            console.warn('Admin check (expert page):', error.message || error);
            return false;
        }
        if (data) return true;
        const { data: urow, error: uerr } = await supabase
            .from('users')
            .select('is_admin')
            .eq('id', currentUser.id)
            .maybeSingle();
        if (uerr) {
            console.warn('Admin check (expert page) users:', uerr.message || uerr);
            return false;
        }
        return !!urow?.is_admin;
    } catch (err) {
        console.warn('Admin check (expert page):', err);
        return false;
    }
}

async function fetchLatestExpertApplicationForUser() {
    try {
        const { data, error } = await supabase
            .from('expert_applications')
            .select('id, status, submitted_at')
            .eq('user_id', currentUser.id)
            .order('submitted_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error) {
            console.warn('Expert application lookup:', error.message || error);
            return null;
        }
        return data;
    } catch (err) {
        console.warn('Expert application lookup:', err);
        return null;
    }
}

function showExpertApplicationAdminLocked() {
    document.getElementById('applicationOpenState')?.classList.add('hidden');
    const locked = document.getElementById('applicationLockedState');
    locked?.classList.remove('hidden');

    const titleEl = document.getElementById('applicationLockedTitle');
    const msgEl = document.getElementById('applicationLockedMessage');
    const metaEl = document.getElementById('applicationLockedMeta');

    if (titleEl) titleEl.textContent = 'No application needed';
    if (msgEl) {
        msgEl.textContent =
            'Your account is an administrator. Admins support the community through the Admin Dashboard, so you do not need to submit a wellness expert application. Use Info & Support if you have questions about your role.';
    }
    if (metaEl) metaEl.textContent = 'Administrator accounts cannot use this form.';
}

function showExpertApplicationLocked(row, userIsExpert) {
    document.getElementById('applicationOpenState')?.classList.add('hidden');
    const locked = document.getElementById('applicationLockedState');
    locked?.classList.remove('hidden');

    const titleEl = document.getElementById('applicationLockedTitle');
    const msgEl = document.getElementById('applicationLockedMessage');
    const metaEl = document.getElementById('applicationLockedMeta');
    const st = String(row.status || 'pending').toLowerCase().trim();

    if (st === 'approved' || st === 'accepted') {
        if (userIsExpert === true) {
            if (titleEl) titleEl.textContent = 'You are a Wellness Expert';
            if (msgEl) {
                msgEl.textContent = 'Your application was approved. Thank you for supporting the GC FitShare community.';
            }
        } else {
            if (titleEl) titleEl.textContent = 'Could not verify expert status';
            if (msgEl) {
                msgEl.textContent =
                    'We could not load your profile from the server. Check your connection and refresh this page. If you are a wellness expert, you will see the success message after we can confirm your account.';
            }
        }
    } else {
        if (titleEl) titleEl.textContent = 'Application already submitted';
        if (msgEl) {
            msgEl.textContent = 'You already submitted an expert application. It is still pending review. Please wait—we will notify you when there is an update. Thank you for your patience.';
        }
    }

    const statusLabel = escapeHtml(String(row.status || 'pending'));
    const submitted = row.submitted_at ? new Date(row.submitted_at).toLocaleString() : '';
    if (metaEl) {
        metaEl.textContent = submitted
            ? `Submitted: ${submitted} · Status: ${statusLabel}`
            : `Status: ${statusLabel}`;
    }
}

// ─── Load User Data (Pre-fill form) ─────────────────────────────────────────
async function loadUserData() {
    try {
        const { data, error } = await supabase
            .from('users')
            .select('full_name, course, age')
            .eq('id', currentUser.id)
            .single();

        if (data) {
            // Pre-fill fields if data exists
            document.getElementById('fullName').value = data.full_name || '';
            document.getElementById('course').value = data.course || '';
            if (data.age) document.getElementById('age').value = data.age;
        }
    } catch (err) {
        console.error('Error loading user data:', err);
    }
}

// ─── Setup Event Listeners ──────────────────────────────────────────────────
function setupFormEventListeners() {
    const form = document.getElementById('expertForm');
    form.addEventListener('submit', handleFormSubmit);

    // Back button (optional on this template)
    document.getElementById('backBtn')?.addEventListener('click', () => {
        window.history.back();
    });

    // Cancel button
    document.getElementById('cancelBtn')?.addEventListener('click', async () => {
        let leave = false;
        if (typeof CustomAlert !== 'undefined' && typeof CustomAlert.confirm === 'function') {
            leave = await CustomAlert.confirm(
                'Cancel application',
                'Are you sure you want to cancel? All changes will be lost.',
                { confirmText: 'Yes, leave', cancelText: 'Keep editing' }
            );
        } else if (typeof confirm === 'function') {
            leave = confirm('Are you sure you want to cancel? All changes will be lost.');
        }
        if (leave) window.history.back();
    });

    // File upload styling
    const fileInput = document.getElementById('certFile');
    const uploadBtn = document.getElementById('uploadBtn');
    const uploadArea = document.getElementById('uploadArea');
    const whyApply = document.getElementById('whyApply');
    const credentials = document.getElementById('credentials');

    uploadBtn?.addEventListener('click', () => fileInput?.click());

    fileInput?.addEventListener('change', (e) => {
        handleFileSelection(e.target.files[0], fileInput);
    });

    // Make upload area clickable
    uploadArea?.addEventListener('click', () => fileInput?.click());

    // Drag and drop UX
    ['dragenter', 'dragover'].forEach(eventName => {
        uploadArea?.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            uploadArea.classList.add('drag-active');
        });
    });

    ['dragleave', 'drop'].forEach(eventName => {
        uploadArea?.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            uploadArea.classList.remove('drag-active');
        });
    });

    uploadArea?.addEventListener('drop', (e) => {
        const droppedFile = e.dataTransfer?.files?.[0];
        if (!droppedFile) return;
        if (fileInput) {
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(droppedFile);
            fileInput.files = dataTransfer.files;
        }
        handleFileSelection(droppedFile, fileInput);
    });

    // Character counters
    whyApply?.addEventListener('input', () => updateCharCounter('whyApply', 'whyApplyCount'));
    credentials?.addEventListener('input', () => updateCharCounter('credentials', 'credentialsCount'));
    updateCharCounter('whyApply', 'whyApplyCount');
    updateCharCounter('credentials', 'credentialsCount');
}

function updateCharCounter(inputId, counterId) {
    const input = document.getElementById(inputId);
    const counter = document.getElementById(counterId);
    if (!input || !counter) return;
    counter.textContent = `${input.value.trim().length} characters`;
}

function handleFileSelection(file, fileInputEl) {
    if (!file) {
        document.getElementById('fileName').textContent = '';
        return;
    }

    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
    if (!allowedTypes.includes(file.type)) {
        showAppAlert('Invalid File Type', 'Please upload only PDF, JPG, or PNG files.', 'error');
        if (fileInputEl) fileInputEl.value = '';
        document.getElementById('fileName').textContent = '';
        return;
    }

    if (file.size > MAX_CERT_FILE_SIZE) {
        showAppAlert('File Too Large', 'File is too large. Maximum allowed size is 5MB.', 'error');
        if (fileInputEl) fileInputEl.value = '';
        document.getElementById('fileName').textContent = '';
        return;
    }

    document.getElementById('fileName').textContent = `Selected: ${file.name}`;
}

// ─── Handle Form Submission ─────────────────────────────────────────────────
async function handleFormSubmit(e) {
    e.preventDefault();

    if (await fetchIsCurrentUserAdmin()) {
        showAppAlert(
            'Not required',
            'Administrators do not submit expert applications. This form is for students and faculty.',
            'info'
        );
        return;
    }

    const submitBtn = document.getElementById('submitBtn');
    const originalText = submitBtn.textContent;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting Application...';

    try {
        const fullName = document.getElementById('fullName').value.trim();
        const age = parseInt(document.getElementById('age').value);
        const course = document.getElementById('course').value.trim();
        const whyApply = document.getElementById('whyApply').value.trim();
        const credentials = document.getElementById('credentials').value.trim();
        const gdriveLink = document.getElementById('gdriveLink').value.trim();

        // Basic validation
        if (!fullName || !age || !course || !whyApply || !credentials) {
            showAppAlert('Missing Required Fields', 'Please fill in all required fields (*).', 'error');
            highlightInvalidFields();
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
            return;
        }

        if (whyApply.length < 30) {
            showAppAlert('More Detail Needed', 'Please provide a more detailed reason (at least 30 characters).', 'error');
            document.getElementById('whyApply')?.classList.add('field-error');
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
            return;
        }

        // Get file if uploaded
        const fileInput = document.getElementById('certFile');
        let certFileUrl = null;

        if (fileInput.files.length > 0) {
            const file = fileInput.files[0];
            const fileExt = file.name.split('.').pop();
            const filePath = `expert-applications/${currentUser.id}-${Date.now()}.${fileExt}`;

            const { error: uploadError } = await supabase.storage
                .from('certifications')
                .upload(filePath, file, { upsert: true });

            if (uploadError) throw uploadError;

            const { data: urlData } = supabase.storage
                .from('certifications')
                .getPublicUrl(filePath);

            certFileUrl = urlData.publicUrl;
        }

        // Matches public.expert_applications: user_id, full_name, course, field_of_expertise,
        // credentials, status, submitted_at (no why_apply / certification_url / gdrive_link columns)
        let credentialsBlock = `Age: ${age}\n\n${credentials}`;
        if (gdriveLink) {
            credentialsBlock += `\n\nGoogle Drive / evidence link: ${gdriveLink}`;
        }
        if (certFileUrl) {
            credentialsBlock += `\n\n[Certification file uploaded: ${certFileUrl}]`;
        }

        const { error } = await supabase.from('expert_applications').insert([{
            user_id: currentUser.id,
            full_name: fullName,
            course: course,
            field_of_expertise: whyApply,
            credentials: credentialsBlock,
            status: 'pending',
            submitted_at: new Date().toISOString()
        }]);

        if (error) throw error;

        if (typeof notifyAllAdmins === 'function') {
            let pendingN = 1;
            try {
                const { count, error: cErr } = await supabase
                    .from('expert_applications')
                    .select('*', { count: 'exact', head: true })
                    .eq('status', 'pending');
                if (!cErr && typeof count === 'number') pendingN = count;
            } catch {
                /* keep 1 */
            }
            await notifyAllAdmins({
                type: 'expert_application',
                title: `New Expert Application (${pendingN} pending): Please check`,
                message: `${fullName} submitted a wellness expert application. Review it in Admin Dashboard → Expert applications.`
            });
        }

        // Success message
        showAppAlert('Application Submitted', 'Your Expert Application has been submitted successfully. It is now under review by the administrators.', 'success');

        // Reset form
        document.getElementById('expertForm').reset();
        document.getElementById('fileName').textContent = '';

        setTimeout(() => {
            window.location.href = '/HTML/2_Main_Feed.html';
        }, 1500);

    } catch (error) {
        console.error('Application submission error:', error);
        showAppAlert('Submission Failed', 'Failed to submit application. Please try again.\n\nError: ' + (error.message || 'Unknown error'), 'error');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Application';
    }
}

function highlightInvalidFields() {
    const requiredFields = ['fullName', 'age', 'course', 'whyApply', 'credentials'];
    requiredFields.forEach((id) => {
        const field = document.getElementById(id);
        if (!field) return;
        if (!field.value?.trim()) {
            field.classList.add('field-error');
            field.addEventListener('input', () => field.classList.remove('field-error'), { once: true });
        }
    });
}

// Dark mode persistence — handled by 0_Footer.js
